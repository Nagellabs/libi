// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { drawOverlay, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { Overlay, ImageOverlay } from "@/lib/engine/types";
import type { OverlayQuadInstance } from "@/lib/engine/overlay-quad";

// ── Fake OffscreenCanvas for getScratchCanvas in Node/jsdom ──────────────────

function makeFake2DCtx() {
  return {
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    drawImage: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    fillRect: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
    globalAlpha: 1,
    filter: "none",
    fillStyle: "#000",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    shadowColor: "transparent",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    strokeStyle: "#000",
    lineWidth: 1,
    imageSmoothingEnabled: true,
    font: "10px sans-serif",
  } as unknown as CanvasRenderingContext2D;
}

let savedOffscreenCanvas: typeof globalThis.OffscreenCanvas | undefined;

beforeAll(() => {
  // jsdom does not ship OffscreenCanvas; stub it so getScratchCanvas uses it.
  savedOffscreenCanvas = (globalThis as unknown as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
  const fakeScratchCtx = makeFake2DCtx();
  const FakeOffscreenCanvas = class {
    width: number;
    height: number;
    constructor(w: number, h: number) { this.width = w; this.height = h; }
    getContext(_type: string) { return fakeScratchCtx; }
  } as unknown as typeof OffscreenCanvas;
  (globalThis as unknown as { OffscreenCanvas: typeof OffscreenCanvas }).OffscreenCanvas = FakeOffscreenCanvas;
});

afterAll(() => {
  if (savedOffscreenCanvas !== undefined) {
    (globalThis as unknown as { OffscreenCanvas: typeof OffscreenCanvas }).OffscreenCanvas = savedOffscreenCanvas;
  } else {
    delete (globalThis as unknown as { OffscreenCanvas?: unknown }).OffscreenCanvas;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMainCtx() {
  const drawImageCalls: unknown[][] = [];
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    clearRect: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn((...args: unknown[]) => drawImageCalls.push(args)),
    measureText: vi.fn(() => ({ width: 10 })),
    globalAlpha: 1,
    filter: "none",
    fillStyle: "#000" as string | CanvasGradient | CanvasPattern,
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    shadowColor: "transparent",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    strokeStyle: "#000" as string | CanvasGradient | CanvasPattern,
    lineWidth: 1,
    imageSmoothingEnabled: true,
    font: "10px sans-serif",
  } as unknown as CanvasRenderingContext2D;
  return { ctx, drawImageCalls };
}

function makeFakeQuad(sentinel: HTMLCanvasElement): { quad: OverlayQuadInstance; renderSpy: ReturnType<typeof vi.fn> } {
  const renderSpy = vi.fn((_content: unknown, _t: unknown, _flip: unknown, _bw: number, _bh: number, _ew: number, _eh: number, _ox: number, _oy: number) => sentinel);
  const quad: OverlayQuadInstance = {
    render: renderSpy as unknown as OverlayQuadInstance["render"],
    dispose: vi.fn(),
  };
  return { quad, renderSpy };
}

const drawCtxBase = {
  width: 1920,
  height: 1080,
  fps: 30,
  totalFrames: 60,
  frame: 0,
  time: 0,
  duration: 2,
  progress: 0,
  assets: {},
} as const;

// A SPATIAL image overlay: transform3d with rotation.x ≠ 0 → classifies as "spatial"
const spatialImageOverlay: ImageOverlay = {
  id: "img1",
  kind: "image",
  fileId: "f1",
  startTime: 0,
  duration: 2,
  z: 1,
  opacity: 1,
  rect: { x: 100, y: 100, width: 200, height: 150 },
  transform3d: {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: Math.PI / 6, y: 0, z: 0 }, // out-of-plane
    scale: { x: 1, y: 1, z: 1 },
  },
} as unknown as ImageOverlay;

// An IDENTITY image overlay (no transform3d)
const identityImageOverlay: Overlay = {
  id: "img2",
  kind: "image",
  fileId: "f2",
  startTime: 0,
  duration: 2,
  z: 1,
  opacity: 1,
  rect: { x: 0, y: 0, width: 200, height: 150 },
} as unknown as Overlay;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("spatial quad dispatch in drawOverlay", () => {
  it("routes a spatial image overlay with a quad instance through quad.render + main ctx.drawImage", () => {
    const { ctx, drawImageCalls } = makeMainCtx();
    const sentinelGl = { width: 200, height: 150 } as unknown as HTMLCanvasElement;
    const img = { naturalWidth: 200, naturalHeight: 150 } as unknown as HTMLImageElement;
    const { quad, renderSpy } = makeFakeQuad(sentinelGl);

    drawOverlay(spatialImageOverlay as unknown as Overlay, {
      ...drawCtxBase,
      ctx,
      imageElements: { img1: img },
      spatialQuads: { img1: quad },
    } as unknown as DrawOverlayContext);

    expect(renderSpy).toHaveBeenCalledTimes(1);
    // The sentinel gl canvas should be drawImage'd onto the main ctx.
    // Since C3, the draw is at the EXPANDED rect (union of base rect + projected bbox),
    // so the position can differ from the raw overlay rect. We verify: (a) the sentinel
    // was drawn, (b) the expanded rect at minimum covers the base rect (x ≤ rect.x,
    // y ≤ rect.y, right ≥ rect.x+rect.width, bottom ≥ rect.y+rect.height).
    const drawImageCall = drawImageCalls.find((args) => args[0] === sentinelGl);
    expect(drawImageCall).toBeTruthy();
    const [, dx, dy, dw, dh] = drawImageCall! as [unknown, number, number, number, number];
    expect(dx).toBeLessThanOrEqual(100);  // expanded.x ≤ rect.x
    expect(dy).toBeLessThanOrEqual(100);  // expanded.y ≤ rect.y
    expect(dx + dw).toBeGreaterThanOrEqual(300);  // expanded right ≥ rect.x + rect.width
    expect(dy + dh).toBeGreaterThanOrEqual(250);  // expanded bottom ≥ rect.y + rect.height
  });

  it("does NOT call quad.render for an identity image overlay (normal path)", () => {
    const { ctx } = makeMainCtx();
    const sentinelGl = { width: 200, height: 150 } as unknown as HTMLCanvasElement;
    const img = { naturalWidth: 200, naturalHeight: 150, width: 200, height: 150 } as unknown as HTMLImageElement;
    const { quad, renderSpy } = makeFakeQuad(sentinelGl);

    drawOverlay(identityImageOverlay, {
      ...drawCtxBase,
      ctx,
      imageElements: { img2: img },
      spatialQuads: { img2: quad }, // quad present but should NOT be used for identity
    } as unknown as DrawOverlayContext);

    expect(renderSpy).not.toHaveBeenCalled();
  });

  it("no-ops gracefully when spatial overlay has no quad instance yet (still building)", () => {
    const { ctx } = makeMainCtx();
    const img = { naturalWidth: 200, naturalHeight: 150 } as unknown as HTMLImageElement;

    // No quad instance present in spatialQuads
    expect(() => {
      drawOverlay(spatialImageOverlay as unknown as Overlay, {
        ...drawCtxBase,
        ctx,
        imageElements: { img1: img },
        spatialQuads: {}, // empty — quad not yet built
      } as unknown as DrawOverlayContext);
    }).not.toThrow();

    // The main ctx should NOT have any drawImage of a gl canvas (quad.render wasn't called)
    // (ctx.drawImage may be called by the fallback content path, but the spatial guard
    //  exits early when quad is absent — verifying no throw is the key assertion here)
    expect((ctx.save as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
    expect((ctx.restore as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
