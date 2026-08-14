import { describe, it, expect } from "vitest";
import { classifyExportShape } from "@/lib/export/classifier";
import { overlayHasKeyframes } from "@/lib/export/overlay-predicates";
import type { Composition, Overlay } from "@/lib/engine/types";

function videoComp(overlays: Composition["overlays"]): Composition {
  return {
    id: "c", name: "c", width: 1280, height: 720, fps: 30,
    scenes: [],
    overlays: [
      // Base video is an OVERLAY now; z:-1 keeps it below the fixtures' z:0
      // overlays so `resolveExportBase` still picks it as the base.
      {
        id: "s1", kind: "video", fileId: "f1",
        startTime: 0, duration: 4, z: -1, opacity: 1, fit: "cover",
        rect: { x: 0, y: 0, width: 1280, height: 720 },
        sourceWidth: 1280, sourceHeight: 720,
      } as never,
      ...(overlays ?? []),
    ],
  };
}

const baseImageOverlay = {
  id: "i1", kind: "image", fileId: "f2", startTime: 0, duration: 4, z: 0, opacity: 1,
  rect: { x: 0, y: 0, width: 100, height: 100 },
} as const;

describe("classifier: keyframed overlays route off the ffmpeg fast path", () => {
  it("a single-video comp with an image overlay that has keyframes.rect -> canvas/chromium (not ffmpeg-overlay)", () => {
    const overlay = {
      ...baseImageOverlay,
      keyframes: {
        rect: {
          keyframes: [
            { t: 0, value: { x: 0, y: 0, width: 100, height: 100 } },
            { t: 1, value: { x: 200, y: 100, width: 100, height: 100 } },
          ],
        },
      },
    } as never;
    const shape = classifyExportShape(videoComp([overlay]));
    expect(shape.tag).toBe("chromium-render");
    expect(shape.tag).not.toBe("ffmpeg-overlay");
  });

  it("the SAME comp WITHOUT keyframes still takes the ffmpeg fast path (regression)", () => {
    const shape = classifyExportShape(videoComp([{ ...baseImageOverlay } as never]));
    expect(shape.tag).toBe("ffmpeg-overlay");
  });

  it("a text overlay with keyframes.opacity -> canvas/chromium fallback", () => {
    const overlay = {
      id: "t1", kind: "text", text: "hi", startTime: 0, duration: 4, z: 0, opacity: 1,
      rect: { x: 0, y: 0, width: 200, height: 60 },
      keyframes: {
        opacity: { keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1 }] },
      },
    } as never;
    const shape = classifyExportShape(videoComp([overlay]));
    expect(shape.tag).toBe("chromium-render");
  });
});

describe("overlayHasKeyframes", () => {
  it("undefined keyframes -> false", () => {
    expect(overlayHasKeyframes({ ...baseImageOverlay } as Overlay)).toBe(false);
  });

  it("empty keyframes object {} -> false", () => {
    expect(overlayHasKeyframes({ ...baseImageOverlay, keyframes: {} } as Overlay)).toBe(false);
  });

  it("a track with an empty keyframes: [] array -> false", () => {
    expect(
      overlayHasKeyframes({ ...baseImageOverlay, keyframes: { opacity: { keyframes: [] } } } as Overlay),
    ).toBe(false);
  });

  it("a track with 1 keyframe -> true", () => {
    expect(
      overlayHasKeyframes({
        ...baseImageOverlay,
        keyframes: { opacity: { keyframes: [{ t: 0, value: 1 }] } },
      } as Overlay),
    ).toBe(true);
  });
});
