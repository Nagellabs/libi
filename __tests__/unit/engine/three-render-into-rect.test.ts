import { describe, it, expect, vi } from "vitest";
import { drawOverlay, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { Overlay } from "@/lib/engine/types";
import type { ThreeOverlayInstance, ThreeFrameApi } from "@/lib/engine/three-overlay";

function mockCtx() {
  return {
    save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(),
    scale: vi.fn(), drawImage: vi.fn(), globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
}

describe('overlay renderer "three" renders into rect (window model)', () => {
  it("calls render(rect.w, rect.h) and drawImage at rect.{x,y,w,h}", () => {
    const renderCalls: number[][] = [];
    const glCanvas = { width: 100, height: 100 } as unknown as HTMLCanvasElement;
    const inst: ThreeOverlayInstance = {
      update: (_a: ThreeFrameApi) => {},
      applyTransform: () => {},
      render: (w: number, h: number) => { renderCalls.push([w, h]); return glCanvas; },
      dispose: () => {},
      ready: Promise.resolve(),
    };
    const overlay: Overlay = {
      id: "tov", kind: "three", startTime: 0, duration: 2, z: 1, opacity: 1,
      rect: { x: 120, y: 60, width: 400, height: 300 },
      sceneFunction: "/* unused */",
    };
    const ctx = mockCtx();
    const drawCtx: DrawOverlayContext = {
      ctx, width: 1920, height: 1080, fps: 30, frame: 30, time: 1, totalFrames: 60,
      assets: {}, threeScenes: { tov: inst },
    };
    drawOverlay(overlay, drawCtx);
    expect(renderCalls).toEqual([[400, 300]]);
    expect(ctx.drawImage).toHaveBeenCalledWith(glCanvas, 120, 60, 400, 300);
  });
});
