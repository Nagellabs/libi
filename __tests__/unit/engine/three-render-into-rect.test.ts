import { describe, it, expect, vi } from "vitest";
import { drawOverlay, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { Overlay } from "@/lib/engine/types";
import { fakeBitmap, fakeLayers } from "@/__tests__/helpers/fake-layers";

function mockCtx() {
  return { save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(), drawImage: vi.fn(), globalAlpha: 1 } as unknown as CanvasRenderingContext2D;
}

describe('overlay renderer "three" renders into rect (window model)', () => {
  it("requests a rect-sized layer at the backing scale and drawImages it 1:1 at rect.{x,y,w,h}", () => {
    const overlay: Overlay = {
      id: "tov", kind: "three", startTime: 0, duration: 2, z: 1, opacity: 1,
      rect: { x: 120, y: 60, width: 400, height: 300 }, sceneFunction: "/* unused */",
    };
    const bmp = fakeBitmap();
    const layers = fakeLayers({ tov: bmp });
    const ctx = mockCtx();
    const drawCtx: DrawOverlayContext = { ctx, width: 1920, height: 1080, fps: 30, frame: 30, time: 1, totalFrames: 60, assets: {}, renderScale: 2, layers };
    drawOverlay(overlay, drawCtx);
    expect(layers.requests[0]).toMatchObject({ kind: "three", size: { width: 400, height: 300 }, pixelRatio: 2 });
    // Source rect = the layer's device px (size × pixelRatio), so the draw is 1:1.
    expect(ctx.drawImage).toHaveBeenCalledWith(bmp, 0, 0, 800, 600, 120, 60, 400, 300);
  });
});
