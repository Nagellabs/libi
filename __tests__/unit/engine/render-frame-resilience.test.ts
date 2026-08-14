// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderFrame } from "@/lib/engine/renderer";
import type { Composition, DrawContext } from "@/lib/engine/types";

/**
 * Regression: a single throwing scene/overlay draw must NOT abort the whole
 * frame. Before this guard, `renderFrame` unwound on the first throw (after
 * clearRect) and the preview loop's silent catch left the ENTIRE canvas blank —
 * one bad canvas-scene body (or a broken 3D-text/code overlay) blanked
 * everything, invisibly. renderFrame now isolates each scene + overlay draw.
 */
function mockCanvas() {
  const canvas = document.createElement("canvas");
  const mockCtx = {
    save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), clearRect: vi.fn(),
    fillRect: vi.fn(), fillText: vi.fn(), strokeText: vi.fn(), drawImage: vi.fn(),
    beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
    translate: vi.fn(), scale: vi.fn(), rotate: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
    font: "", textAlign: "left", textBaseline: "alphabetic",
    fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, lineJoin: "round",
    filter: "none", globalAlpha: 1, shadowColor: "", shadowBlur: 0,
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(canvas, "getContext").mockReturnValue(mockCtx as never);
  return { canvas, mockCtx };
}

describe("renderFrame draw isolation", () => {
  it("a throwing canvas-scene draw does not abort the frame", () => {
    const comp: Composition = {
      id: "c", name: "c", width: 100, height: 100, fps: 30,
      scenes: [{ id: "s1", name: "s1", type: "canvas", duration: 2,
        draw: () => { throw new ReferenceError("ctx is not defined"); } }],
    };
    const { canvas, mockCtx } = mockCanvas();
    expect(() => renderFrame(canvas, comp, 0)).not.toThrow();
    // Frame still progressed past the cleared canvas.
    expect(mockCtx.clearRect).toHaveBeenCalled();
  });

  it("a throwing overlay does not prevent the base scene from drawing", () => {
    const sceneDraw = vi.fn((_ctx: DrawContext) => {});
    const comp: Composition = {
      id: "c", name: "c", width: 100, height: 100, fps: 30,
      scenes: [{ id: "s1", name: "s1", type: "canvas", duration: 2, draw: sceneDraw }],
      overlays: [{
        id: "o1", kind: "code", startTime: 0, duration: 2, z: 0,
        rect: { x: 0, y: 0, width: 50, height: 50 }, opacity: 1,
        drawFunction: "",
      }],
    };
    const { canvas } = mockCanvas();
    const compiled = { o1: () => { throw new Error("bad code overlay"); } };
    expect(() => renderFrame(canvas, comp, 0, {}, undefined, undefined, compiled)).not.toThrow();
    // The base scene drew even though the overlay threw.
    expect(sceneDraw).toHaveBeenCalledTimes(1);
  });
});
