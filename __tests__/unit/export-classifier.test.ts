import { describe, it, expect } from "vitest";
import { classifyExportShape } from "@/lib/export/classifier";
import type { Composition, VideoOverlay } from "@/lib/engine/types";

function mkComp(overrides: Partial<Composition>): Composition {
  return {
    id: "c", name: "", width: 1920, height: 1080, fps: 30, 
    ...overrides,
  };
}

/**
 * A full-frame, opaque, cover-fit, untransformed video overlay at z=0 — the
 * shape `resolveExportBase` accepts as ffmpeg's base input. Source dims match
 * `mkComp`'s 1920x1080 so `streamCopyPreservesFraming` passes; a mismatch is
 * exercised separately below.
 */
function baseVideo(overrides: Partial<VideoOverlay> = {}): VideoOverlay {
  return {
    id: "v", kind: "video", fileId: "f", videoUrl: "/x",
    startTime: 0, duration: 2, z: 0, opacity: 1, fit: "cover",
    rect: { x: 0, y: 0, width: 1920, height: 1080 },
    sourceWidth: 1920, sourceHeight: 1080,
    ...overrides,
  };
}

describe("classifyExportShape", () => {
  it("empty composition (no overlays or audio) → 'error'", () => {
    expect(classifyExportShape(mkComp({ overlays: [] }))).toEqual({ tag: "error", reason: "nothing to export" });
  });

  it("single base video overlay, no other overlay, no trim → 'stream-copy-trim'", () => {
    expect(
      classifyExportShape(mkComp({ overlays: [baseVideo({ trim: undefined })] })),
    ).toEqual({ tag: "stream-copy-trim" });
  });

  it("single base video overlay, trim set → 'stream-copy-trim'", () => {
    expect(
      classifyExportShape(
        mkComp({ overlays: [baseVideo({ duration: 1, trim: { start: 2, end: 3 } })] }),
      ),
    ).toEqual({ tag: "stream-copy-trim" });
  });

  it("base video overlay whose source dims differ from the comp → 'ffmpeg-overlay' (stream-copy can't rescale)", () => {
    expect(
      classifyExportShape(
        mkComp({ overlays: [baseVideo({ sourceWidth: 1080, sourceHeight: 1920 })] }),
      ),
    ).toEqual({ tag: "ffmpeg-overlay" });
  });

  it("base video overlay + a text overlay → 'ffmpeg-overlay'", () => {
    expect(
      classifyExportShape(
        mkComp({
          overlays: [
            baseVideo(),
            {
              id: "t1", kind: "text", content: "hi", font: "40px sans-serif",
              color: "#fff", align: "center",
              rect: { x: 0, y: 0, width: 100, height: 20 },
              startTime: 0, duration: 1, z: 1, opacity: 1,
            },
          ],
        }),
      ),
    ).toEqual({ tag: "ffmpeg-overlay" });
  });

  it("base video overlay + a code overlay → 'chromium-render' (ffmpeg can't run JS draw fns)", () => {
    expect(
      classifyExportShape(
        mkComp({
          overlays: [
            baseVideo(),
            {
              id: "c1", kind: "code", drawFunction: "ctx.fillRect(0,0,10,10)",
              rect: { x: 0, y: 0, width: 100, height: 20 },
              startTime: 0, duration: 1, z: 1, opacity: 1,
            },
          ],
        }),
      ),
    ).toEqual({ tag: "chromium-render" });
  });

  it("routes single-video comp with audioClips to ffmpeg-overlay", () => {
    // A trim-only base video with NO other overlays but WITH an audioClip must
    // route through FfmpegOverlayBackend so the clip mixes in via amix.
    // Before this fix, the classifier sent these comps to
    // StreamCopyTrimBackend (-c copy), which silently dropped the audio.
    expect(
      classifyExportShape(
        mkComp({
          overlays: [baseVideo({ duration: 3 })],
          audioClips: [
            {
              id: "t1", kind: "standalone", fileId: "ft",
              startTime: 0, duration: 3, trimStart: 0, volume: 1, enabled: true,
            },
          ],
        }),
      ),
    ).toEqual({ tag: "ffmpeg-overlay" });
  });

  it("two full-frame video overlays at the same z → 'chromium-render' (ambiguous base)", () => {
    expect(
      classifyExportShape(
        mkComp({
          overlays: [
            baseVideo({ id: "v1", fileId: "f1" }),
            baseVideo({ id: "v2", fileId: "f2" }),
          ],
        }),
      ),
    ).toEqual({ tag: "chromium-render" });
  });
});
