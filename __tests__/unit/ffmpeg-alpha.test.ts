/**
 * Unit: alpha-awareness helpers (`lib/ffmpeg/alpha.ts`).
 *
 * Why this exists: an alpha-bearing video (VP9-alpha WebM cutout from
 * `matte_gen`, or a fal-imported transparent WebM) silently loses its alpha
 * through any pipeline stage that decodes with ffmpeg's NATIVE vp9 decoder
 * (WebM stores alpha as a side-band the native decoder skips) or re-encodes
 * to yuv420p (proxies). `streamHasAlpha` is the single honest detection rule;
 * `vpxAlphaDecodeArgs` is the single source for the `-c:v libvpx-vp9` input
 * flags every alpha-preserving ffmpeg read must use.
 */
import { describe, it, expect } from "vitest";
import {
  alphaRecoverableInPreview,
  streamHasAlpha,
  vpxAlphaDecodeArgs,
} from "@/lib/ffmpeg/alpha";

describe("streamHasAlpha", () => {
  it("detects WebM VP9 alpha via the alpha_mode stream tag (pix_fmt lies as yuv420p)", () => {
    // Real ffprobe output for a matte_gen cutout: the native decoder reports
    // yuv420p, but the container tags the alpha side-band.
    expect(
      streamHasAlpha({ pix_fmt: "yuv420p", tags: { alpha_mode: "1" } }),
    ).toBe(true);
  });

  it("detects the alpha_mode tag REGARDLESS OF KEY CASE (muxers disagree)", () => {
    // Found in real dogfooding: our own libvpx-vp9 encoder writes the tag
    // lowercase (`alpha_mode`), but Bria's fal endpoint writes it UPPERCASE
    // (`ALPHA_MODE`). A case-sensitive lookup matched every file we produced
    // and missed every alpha WebM that came from a third party — which then
    // got an alpha-stripping proxy and rendered as the original scene.
    expect(
      streamHasAlpha({ pix_fmt: "yuv420p", tags: { ALPHA_MODE: "1" } }),
    ).toBe(true);
    expect(
      streamHasAlpha({ pix_fmt: "yuv420p", tags: { Alpha_Mode: "1" } }),
    ).toBe(true);
    // ...and an explicit "0" still means opaque, in any case.
    expect(
      streamHasAlpha({ pix_fmt: "yuv420p", tags: { ALPHA_MODE: "0" } }),
    ).toBe(false);
  });

  it("detects alpha pixel formats directly", () => {
    for (const pix_fmt of [
      "yuva420p",
      "yuva444p10le",
      "rgba",
      "bgra",
      "argb",
      "abgr",
      "gbrap",
      "ya8",
    ]) {
      expect(streamHasAlpha({ pix_fmt })).toBe(true);
    }
  });

  it("reports false for opaque formats", () => {
    for (const pix_fmt of ["yuv420p", "yuv422p10le", "rgb24", "nv12", "gray"]) {
      expect(streamHasAlpha({ pix_fmt })).toBe(false);
    }
    expect(streamHasAlpha({ pix_fmt: "yuv420p", tags: { alpha_mode: "0" } })).toBe(false);
    expect(streamHasAlpha({})).toBe(false);
  });
});

describe("vpxAlphaDecodeArgs", () => {
  it("forces libvpx-vp9 for an alpha-tagged vp9 stream", () => {
    expect(vpxAlphaDecodeArgs({ hasAlpha: true, videoCodec: "vp9" })).toEqual([
      "-c:v",
      "libvpx-vp9",
    ]);
  });

  it("forces libvpx for an alpha-tagged vp8 stream", () => {
    expect(vpxAlphaDecodeArgs({ hasAlpha: true, videoCodec: "vp8" })).toEqual([
      "-c:v",
      "libvpx",
    ]);
  });

  it("returns no flags for non-vpx alpha codecs (native decoders keep their alpha)", () => {
    expect(vpxAlphaDecodeArgs({ hasAlpha: true, videoCodec: "prores" })).toEqual([]);
    expect(vpxAlphaDecodeArgs({ hasAlpha: true, videoCodec: undefined })).toEqual([]);
  });

  it("returns no flags for opaque files", () => {
    expect(vpxAlphaDecodeArgs({ hasAlpha: false, videoCodec: "vp9" })).toEqual([]);
    expect(vpxAlphaDecodeArgs({ hasAlpha: null, videoCodec: "vp9" })).toEqual([]);
    expect(vpxAlphaDecodeArgs({ hasAlpha: undefined, videoCodec: "vp9" })).toEqual([]);
  });
});

describe("alphaRecoverableInPreview", () => {
  // The ONE decision point for "should this alpha file skip / drop / refuse a
  // proxy?". True only for the VPx family, where serving the ORIGINAL keeps
  // alpha visible in preview. For every other alpha carrier (ProRes 4444,
  // qtrle, PNG-in-MOV) preview generally cannot decode the original at all —
  // an opaque proxy is strictly better than no preview, so those must NOT be
  // treated like cutouts.
  it("is true for VPx alpha (codec signal wins)", () => {
    expect(alphaRecoverableInPreview({ hasAlpha: true, videoCodec: "vp9" })).toBe(true);
    expect(alphaRecoverableInPreview({ hasAlpha: true, videoCodec: "vp8" })).toBe(true);
  });

  it("is false for non-VPx alpha codecs (ProRes 4444, qtrle, png)", () => {
    for (const videoCodec of ["prores", "qtrle", "png", "ffv1"]) {
      expect(alphaRecoverableInPreview({ hasAlpha: true, videoCodec })).toBe(false);
    }
  });

  it("codec signal beats the container fallback in both directions", () => {
    // Probe says prores even though the name says .webm — trust the probe.
    expect(
      alphaRecoverableInPreview({ hasAlpha: true, videoCodec: "prores", filename: "x.webm" }),
    ).toBe(false);
    // Probe says vp9 in a non-webm container (mkv) — still VPx alpha.
    expect(
      alphaRecoverableInPreview({ hasAlpha: true, videoCodec: "vp9", filename: "x.mkv" }),
    ).toBe(true);
  });

  it("falls back to the WebM container signal when no codec is known", () => {
    expect(alphaRecoverableInPreview({ hasAlpha: true, filename: "cutout.webm" })).toBe(true);
    expect(alphaRecoverableInPreview({ hasAlpha: true, filename: "CUTOUT.WEBM" })).toBe(true);
    expect(
      alphaRecoverableInPreview({ hasAlpha: true, filename: "clip.mp4", contentType: "video/webm" }),
    ).toBe(true);
    expect(
      alphaRecoverableInPreview({
        hasAlpha: true,
        filename: "graphics.mov",
        contentType: "video/quicktime",
      }),
    ).toBe(false);
  });

  it("is always false for opaque / unknown-alpha files", () => {
    expect(alphaRecoverableInPreview({ hasAlpha: false, videoCodec: "vp9" })).toBe(false);
    expect(alphaRecoverableInPreview({ hasAlpha: null, filename: "cutout.webm" })).toBe(false);
    expect(alphaRecoverableInPreview({ hasAlpha: undefined, videoCodec: "vp9" })).toBe(false);
  });
});
