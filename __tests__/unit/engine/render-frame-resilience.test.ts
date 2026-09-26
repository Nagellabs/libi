// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderFrame } from "@/lib/engine/renderer";
import type { Composition } from "@/lib/engine/types";
import { fakeBitmap, fakeLayers } from "@/__tests__/helpers/fake-layers";

/**
 * Regression: a single throwing overlay draw must NOT abort the whole frame.
 * Before this guard, `renderFrame` unwound on the first throw (after clearRect)
 * and the preview loop's silent catch left the ENTIRE canvas blank — one broken
 * code or 3D-text overlay blanked everything, invisibly. renderFrame now
 * isolates each overlay draw. Bodies render in the sandbox now (spec §4.4),
 * so the host-side thrower is the LayerSource an overlay reads through.
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

function codeOverlay(id: string, z: number) {
  return {
    id, kind: "code" as const, startTime: 0, duration: 2, z,
    rect: { x: 0, y: 0, width: 50, height: 50 }, opacity: 1,
    drawFunction: "",
  };
}

describe("renderFrame draw isolation", () => {
  it("a throwing overlay draw does not abort the frame", () => {
    const comp: Composition = {
      id: "c", name: "c", width: 100, height: 100, fps: 30,
      overlays: [codeOverlay("o1", 0)],
    };
    const { canvas, mockCtx } = mockCanvas();
    const layers = fakeLayers({}, { throwOnGet: ["o1"] });
    expect(() => renderFrame(canvas, comp, 0, {}, undefined, undefined, layers)).not.toThrow();
    // Frame still progressed past the cleared canvas.
    expect(mockCtx.clearRect).toHaveBeenCalled();
  });

  it("a throwing overlay does not prevent its siblings from drawing", () => {
    const comp: Composition = {
      id: "c", name: "c", width: 100, height: 100, fps: 30,
      // The thrower sits UNDERNEATH, so a frame that unwound on it would never
      // reach the one above — which is exactly the bug this guards.
      overlays: [codeOverlay("bad", 0), codeOverlay("good", 1)],
    };
    const { canvas } = mockCanvas();
    const layers = fakeLayers({ good: fakeBitmap() }, { throwOnGet: ["bad"] });
    expect(() => renderFrame(canvas, comp, 0, {}, undefined, undefined, layers)).not.toThrow();
    expect(layers.requests.filter((r) => r.overlayId === "good")).toHaveLength(1);
  });

  // QA 2026-09-18 B1: the throw was only visible as an info-level console
  // line inside the render page — nothing structured reached the export
  // result. renderFrame now accepts an optional callback so a caller (the
  // export loop) can collect which overlays were skipped and why.
  it("reports a throwing overlay's id and message via onOverlayDropped", () => {
    const comp: Composition = {
      id: "c", name: "c", width: 100, height: 100, fps: 30,
      overlays: [codeOverlay("o1", 0)],
    };
    const { canvas } = mockCanvas();
    const layers = fakeLayers({}, { throwOnGet: ["o1"] });
    const onOverlayDropped = vi.fn();
    renderFrame(
      canvas, comp, 0, {}, undefined, undefined, layers,
      undefined, undefined, undefined,
      onOverlayDropped,
    );
    expect(onOverlayDropped).toHaveBeenCalledWith("o1", "layer o1 failed");
  });

  it("does not call onOverlayDropped when no overlay throws", () => {
    const comp: Composition = {
      id: "c", name: "c", width: 100, height: 100, fps: 30,
      overlays: [codeOverlay("good", 0)],
    };
    const { canvas } = mockCanvas();
    const onOverlayDropped = vi.fn();
    renderFrame(
      canvas, comp, 0, {}, undefined, undefined, fakeLayers({ good: fakeBitmap() }),
      undefined, undefined, undefined,
      onOverlayDropped,
    );
    expect(onOverlayDropped).not.toHaveBeenCalled();
  });
});
