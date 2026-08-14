/**
 * Unit: `buildThumbnailArgs` (`lib/ffmpeg/thumb-args.ts`) — the pure args
 * builder behind `libi.generate_thumbnails`.
 *
 * The alpha path is the load-bearing part: a VP9-alpha WebM cutout decoded
 * with the NATIVE vp9 decoder yields the FULL ORIGINAL FRAME (alphamerge
 * keeps the RGB planes intact), so a plain `-i cutout.webm → .jpg` thumbnail
 * shows "the feature did nothing" for a perfectly correct cutout. Alpha
 * sources must (a) decode via libvpx so the alpha side-band is honored and
 * (b) be composited over SOLID MAGENTA so a JPG can show where transparency
 * is — the skill's verify rubric keys on "background replaced by magenta".
 */
import { describe, it, expect } from "vitest";
import { buildThumbnailArgs } from "@/lib/ffmpeg/thumb-args";

describe("buildThumbnailArgs — opaque path", () => {
  it("keeps the legacy single-frame jpg extraction shape", () => {
    const args = buildThumbnailArgs({
      sourcePath: "/src/clip.mp4",
      outPath: "/out/clip-thumb-01.jpg",
      time: 1.25,
      alpha: null,
    });
    expect(args).toEqual([
      "-y",
      "-ss", "1.25",
      "-i", "/src/clip.mp4",
      "-frames:v", "1",
      "-q:v", "4",
      "/out/clip-thumb-01.jpg",
    ]);
  });
});

describe("buildThumbnailArgs — alpha path", () => {
  const args = buildThumbnailArgs({
    sourcePath: "/src/clip-cutout.webm",
    outPath: "/out/clip-cutout-thumb-01.jpg",
    time: 1.5,
    alpha: { videoCodec: "vp9" },
  });

  it("forces the libvpx-vp9 decoder BEFORE the input (input option position)", () => {
    const decoderIdx = args.indexOf("libvpx-vp9");
    const inputIdx = args.indexOf("/src/clip-cutout.webm");
    expect(decoderIdx).toBeGreaterThan(-1);
    expect(args[decoderIdx - 1]).toBe("-c:v");
    expect(decoderIdx).toBeLessThan(inputIdx);
  });

  it("composites the frame over solid magenta via filter_complex", () => {
    const fcIdx = args.indexOf("-filter_complex");
    expect(fcIdx).toBeGreaterThan(-1);
    const graph = args[fcIdx + 1];
    expect(graph).toContain("format=rgba");
    expect(graph).toContain("drawbox=color=magenta:t=fill");
    expect(graph).toContain("overlay");
  });

  it("still extracts exactly one frame to the jpg path", () => {
    expect(args).toContain("-frames:v");
    expect(args[args.length - 1]).toBe("/out/clip-cutout-thumb-01.jpg");
  });

  it("does not force a decoder for non-vpx alpha sources", () => {
    const prores = buildThumbnailArgs({
      sourcePath: "/src/clip.mov",
      outPath: "/out/t.jpg",
      time: 0.5,
      alpha: { videoCodec: "prores" },
    });
    expect(prores).not.toContain("libvpx-vp9");
    // ...but still composites over magenta.
    expect(prores.join(" ")).toContain("drawbox=color=magenta:t=fill");
  });
});
