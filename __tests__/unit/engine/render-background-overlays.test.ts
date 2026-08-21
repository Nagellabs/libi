// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderFrame } from "@/lib/engine/renderer";
import type { Composition } from "@/lib/engine/types";

/**
 * Empty-scenes path: a video-less piece (scenes: []) must render a solid
 * background + overlays instead of indexing scenes[-1] and throwing. The
 * overlay loop already runs independently of scenes; only the base-scene
 * draw path needs an empty guard.
 */
function mockCanvas() {
  const fillRectCalls: Array<{ fillStyle: string }> = [];
  const mockCtx = {
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    // record the fillStyle at fillRect time so we can assert the bg fill.
    fillRect: vi.fn(function (this: { fillStyle: string }) {
      fillRectCalls.push({ fillStyle: (mockCtx as { fillStyle: string }).fillStyle });
    }),
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
  vi.spyOn(canvas, "getContext").mockReturnValue(mockCtx as never);
  return { canvas, mockCtx, fillRectCalls };
}

describe("renderFrame with empty scenes", () => {
  it("fills the background and runs the overlay path with one overlay", () => {
    const comp: Composition = {
      id: "c",
      name: "c",
      width: 100,
      height: 100,
      fps: 30,
      backgroundColor: "#123456",
      overlays: [
        {
          id: "o1",
          kind: "code",
          startTime: 0,
          duration: 2,
          z: 0,
          rect: { x: 0, y: 0, width: 50, height: 50 },
          opacity: 1,
          drawFunction: "",
        },
      ],
    };
    const { canvas, fillRectCalls } = mockCanvas();
    const overlayDraw = vi.fn();
    const compiled = { o1: overlayDraw };
    expect(() =>
      renderFrame(canvas, comp, 0, {}, undefined, undefined, compiled),
    ).not.toThrow();
    // Background filled with the comp's backgroundColor.
    expect(fillRectCalls.some((c) => c.fillStyle === "#123456")).toBe(true);
    // Overlay draw path ran.
    expect(overlayDraw).toHaveBeenCalledTimes(1);
  });

  it("fills the default-black background with no overlays and does not throw", () => {
    const comp: Composition = {
      id: "c",
      name: "c",
      width: 100,
      height: 100,
      fps: 30,
    };
    const { canvas, fillRectCalls } = mockCanvas();
    expect(() => renderFrame(canvas, comp, 0)).not.toThrow();
    // Default background is black.
    expect(fillRectCalls.some((c) => c.fillStyle === "#000000")).toBe(true);
  });
});
