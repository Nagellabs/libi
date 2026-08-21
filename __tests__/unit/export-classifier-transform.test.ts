import { describe, it, expect } from "vitest";
import { classifyExportShape } from "@/lib/export/classifier";
import { overlayHasNonIdentityTransform } from "@/lib/export/overlay-predicates";
import type { Composition, TextOverlay, VideoOverlay } from "@/lib/engine/types";

function mkComp(overrides: Partial<Composition>): Composition {
  return { id: "c", name: "", width: 1920, height: 1080, fps: 30, ...overrides };
}

/** Base-shaped full-frame video overlay (ffmpeg's `[0:v]` input). */
const baseVideo: VideoOverlay = {
  id: "a",
  kind: "video",
  fileId: "f",
  videoUrl: "/x",
  startTime: 0,
  duration: 2,
  z: 0,
  opacity: 1,
  fit: "cover",
  rect: { x: 0, y: 0, width: 1920, height: 1080 },
  sourceWidth: 1920,
  sourceHeight: 1080,
};

function txt(extra: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id: "t",
    kind: "text",
    content: "hi",
    font: "48px Inter",
    color: "#fff",
    align: "center",
    opacity: 1,
    rect: { x: 0, y: 0, width: 100, height: 40 },
    startTime: 0,
    duration: 2,
    z: 0,
    ...extra,
  };
}

describe("overlayHasNonIdentityTransform", () => {
  it("false for no transform", () => {
    expect(overlayHasNonIdentityTransform(txt())).toBe(false);
  });
  it("true for a non-zero transform3d spin (rotation.z)", () => {
    expect(
      overlayHasNonIdentityTransform(
        txt({ transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: (15 * Math.PI) / 180 } } }),
      ),
    ).toBe(true);
  });
  it("true for flipH", () => {
    expect(overlayHasNonIdentityTransform(txt({ flipH: true }))).toBe(true);
  });
  it("true for flipV", () => {
    expect(overlayHasNonIdentityTransform(txt({ flipV: true }))).toBe(true);
  });
});

describe("classifyExportShape transform gating", () => {
  it("base video overlay + plain text overlay → ffmpeg-overlay", () => {
    expect(
      classifyExportShape(mkComp({ overlays: [baseVideo, txt()] })),
    ).toEqual({ tag: "ffmpeg-overlay" });
  });

  it("rotated text overlay → chromium-render (fallback)", () => {
    expect(
      classifyExportShape(
        mkComp({
          overlays: [baseVideo, txt({ transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: (15 * Math.PI) / 180 } } })],
        }),
      ),
    ).toEqual({ tag: "chromium-render" });
  });

  it("flipH text overlay → chromium-render (fallback)", () => {
    expect(
      classifyExportShape(mkComp({ overlays: [baseVideo, txt({ flipH: true })] })),
    ).toEqual({ tag: "chromium-render" });
  });

  it("plain move/resize (no transform) stays ffmpeg-overlay", () => {
    expect(
      classifyExportShape(
        mkComp({
          overlays: [baseVideo, txt({ rect: { x: 500, y: 200, width: 300, height: 80 } })],
        }),
      ),
    ).toEqual({ tag: "ffmpeg-overlay" });
  });
});
