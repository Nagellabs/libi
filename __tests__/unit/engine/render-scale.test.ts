// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderFrame } from "@/lib/engine/renderer";
import type { Composition, DrawContext } from "@/lib/engine/types";

/**
 * Render-scale contract: the canvas backing store IS the render resolution.
 * renderFrame must NOT clamp the canvas to the composition's logical size — it
 * scales the coordinate space (base ctx transform) so overlays rasterize at the
 * backing density (crisp on 4K export / HiDPI preview) while draw code keeps
 * using logical composition pixels. renderScale (canvas.width / composition.width)
 * is threaded into every DrawContext.
 */
function mockCanvas(backingW: number, backingH: number) {
  const setTransform = vi.fn();
  const mockCtx = {
    save: vi.fn(),
    restore: vi.fn(),
    setTransform,
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    lineJoin: "round",
    filter: "none",
    globalAlpha: 1,
    shadowColor: "",
    shadowBlur: 0,
  } as unknown as CanvasRenderingContext2D;
  const canvas = document.createElement("canvas");
  canvas.width = backingW;
  canvas.height = backingH;
  vi.spyOn(canvas, "getContext").mockReturnValue(mockCtx as never);
  return { canvas, mockCtx, setTransform };
}

function comp(overlayDraw?: (ctx: DrawContext) => void): {
  composition: Composition;
  compiled: Record<string, (ctx: DrawContext) => void>;
} {
  return {
    composition: {
      id: "c",
      name: "c",
      width: 100,
      height: 100,
      fps: 30,
      scenes: [],
      overlays: overlayDraw
        ? [
            {
              id: "o1",
              kind: "code",
              startTime: 0,
              duration: 2,
              z: 0,
              rect: { x: 0, y: 0, width: 50, height: 50 },
              opacity: 1,
              drawFunction: "",
            } as never,
          ]
        : [],
    },
    compiled: overlayDraw ? { o1: overlayDraw } : {},
  };
}

describe("renderFrame render-scale", () => {
  it("applies a 2x base transform for a 2x backing store and does NOT clamp the canvas", () => {
    const { canvas, setTransform } = mockCanvas(200, 200);
    const { composition, compiled } = comp();
    renderFrame(canvas, composition, 0, {}, undefined, undefined, compiled);
    // Backing store preserved (not clobbered back to 100x100).
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(200);
    // Base transform is the composition→backing scale.
    expect(setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
  });

  it("threads renderScale into an overlay's draw context", () => {
    let seen: number | undefined;
    const { canvas } = mockCanvas(200, 200);
    const { composition, compiled } = comp((ctx) => {
      seen = ctx.renderScale;
    });
    renderFrame(canvas, composition, 0, {}, undefined, undefined, compiled);
    expect(seen).toBe(2);
  });

  it("scale 1 when backing == composition (legacy behavior preserved)", () => {
    const { canvas, setTransform } = mockCanvas(100, 100);
    const { composition, compiled } = comp();
    renderFrame(canvas, composition, 0, {}, undefined, undefined, compiled);
    expect(setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
    expect(canvas.width).toBe(100);
  });

  it("4K export scenario: a 3840×2160 canvas over a 1920×1080 comp renders at ×2, not clamped to 1080", () => {
    // This is exactly what lib/engine/export.ts does — allocate the canvas at the
    // target resolution. renderFrame must keep it (true 4K frames), not shrink it
    // back to the logical 1080 and let ffmpeg upscale a soft 1080 frame.
    const { canvas, setTransform } = mockCanvas(3840, 2160);
    const composition: Composition = {
      id: "c",
      name: "c",
      width: 1920,
      height: 1080,
      fps: 30,
      scenes: [],
      overlays: [],
    };
    renderFrame(canvas, composition, 0);
    expect(canvas.width).toBe(3840);
    expect(canvas.height).toBe(2160);
    expect(setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
  });

  it("falls back to composition dims for a zero-sized canvas (scale 1)", () => {
    const { canvas, setTransform } = mockCanvas(0, 0);
    const { composition, compiled } = comp();
    renderFrame(canvas, composition, 0, {}, undefined, undefined, compiled);
    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(100);
    expect(setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
  });
});
