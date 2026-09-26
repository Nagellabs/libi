// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { drawOverlay, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { Overlay } from "@/lib/engine/types";
import { fakeBitmap, fakeLayers } from "@/__tests__/helpers/fake-layers";

function mockCtx() {
  return {
    save: vi.fn(), restore: vi.fn(), translate: vi.fn(),
    beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
    fillText: vi.fn(), drawImage: vi.fn(),
    font: "", textAlign: "left", textBaseline: "alphabetic", fillStyle: "#000",
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
}

describe("code overlay element-local timing", () => {
  it("remaps composition-global time to the overlay window", () => {
    const layers = fakeLayers({ ov: fakeBitmap() });
    const overlay: Overlay = {
      id: "ov", kind: "code", startTime: 0, duration: 3, z: 1, opacity: 1,
      rect: { x: 10, y: 20, width: 200, height: 80 },
      drawFunction: "/* unused: the layer comes from the fake source */",
    };
    const base: DrawOverlayContext = {
      ctx: mockCtx(), width: 1920, height: 1080, fps: 30,
      // Composition-global context (mirrors renderer's overlay pass): the comp
      // is 30s long (900 frames) and we're at t=2.9s — near the END of the
      // 3s overlay but only ~10% through the whole comp.
      frame: 87, time: 2.9, totalFrames: 900,
      assets: {},
      layers,
    };
    drawOverlay(overlay, base);

    expect(layers.requests).toHaveLength(1);
    const req = layers.requests[0];
    // Element-local, NOT global:
    expect(req.time.frame).toBe(87);             // round(2.9 * 30)
    expect(req.time.time).toBeCloseTo(2.9);      // 2.9 - 0
    expect(req.time.totalFrames).toBe(90);       // 3s * 30, NOT 900
    expect(req.time.duration).toBe(3);
    expect(req.time.progress).toBeCloseTo(2.9 / 3); // ~0.967 → reveal nearly done
    // rect-local layer dims:
    expect(req.size.width).toBe(200);
    expect(req.size.height).toBe(80);
  });

  it("offsets by startTime for a mid-composition overlay", () => {
    const layers = fakeLayers({ ov2: fakeBitmap() });
    const overlay: Overlay = {
      id: "ov2", kind: "code", startTime: 10, duration: 4, z: 1, opacity: 1,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      drawFunction: "/* unused */",
    };
    const base: DrawOverlayContext = {
      ctx: mockCtx(), width: 1920, height: 1080, fps: 30,
      frame: 360, time: 12, totalFrames: 900, assets: {},
      layers,
    };
    drawOverlay(overlay, base);
    expect(layers.requests[0].time.time).toBeCloseTo(2);       // 12 - 10
    expect(layers.requests[0].time.frame).toBe(60);            // 2s * 30
    expect(layers.requests[0].time.progress).toBeCloseTo(0.5); // 2 / 4
  });
});
