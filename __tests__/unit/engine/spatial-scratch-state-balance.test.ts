// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { drawOverlay, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { Overlay, DrawContext } from "@/lib/engine/types";
import type { OverlayQuadInstance } from "@/lib/engine/overlay-quad";

/**
 * A 2D overlay with an out-of-plane (spatial) transform draws its content into
 * ONE module-level scratch canvas, then projects it through a GL quad. That
 * scratch context is reused across overlays and frames, and nothing saved or
 * restored around the content draw: the code case's clip-to-rect, translate
 * and content-fit scale stayed on it after every draw (throwing or not), so
 * the next draw — and the next frame's clearRect — ran clipped and offset.
 * Review of 53db53c3 (MINOR 1).
 */
type Rect = { x: number; y: number; w: number; h: number };
const scratch = {
  stack: [] as Array<{ clip: Rect | null; tx: number }>,
  clip: null as Rect | null,
  tx: 0,
  pending: null as Rect | null,
  clears: [] as Array<{ clip: Rect | null; tx: number }>,
};

function scratchCtx() {
  return {
    save: () => { scratch.stack.push({ clip: scratch.clip, tx: scratch.tx }); },
    restore: () => {
      const s = scratch.stack.pop();
      if (s) { scratch.clip = s.clip; scratch.tx = s.tx; }
    },
    beginPath: () => { scratch.pending = null; },
    rect: (x: number, y: number, w: number, h: number) => { scratch.pending = { x, y, w, h }; },
    clip: () => { scratch.clip = scratch.pending; },
    translate: (x: number) => { scratch.tx += x; },
    scale: vi.fn(), rotate: vi.fn(), setTransform: vi.fn(),
    clearRect: () => { scratch.clears.push({ clip: scratch.clip, tx: scratch.tx }); },
    drawImage: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), strokeText: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
    globalAlpha: 1, filter: "none", font: "10px sans-serif",
  } as unknown as CanvasRenderingContext2D;
}

let saved: unknown;
beforeAll(() => {
  saved = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
  const ctx = scratchCtx();
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {
    width: number; height: number;
    constructor(w: number, h: number) { this.width = w; this.height = h; }
    getContext() { return ctx; }
  };
});
afterAll(() => {
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = saved;
});

function mainCtx() {
  return {
    save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(),
    beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(),
    fillRect: vi.fn(), fillText: vi.fn(), strokeText: vi.fn(), measureText: vi.fn(() => ({ width: 10 })),
    globalAlpha: 1, filter: "none", font: "10px sans-serif",
  } as unknown as CanvasRenderingContext2D;
}

const quad: OverlayQuadInstance = {
  render: vi.fn(() => ({ width: 200, height: 150 })) as unknown as OverlayQuadInstance["render"],
  dispose: vi.fn(),
};

const spatialCode = {
  id: "c1", kind: "code", startTime: 0, duration: 2, z: 1, opacity: 1, drawFunction: "",
  rect: { x: 100, y: 100, width: 200, height: 150 },
  transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: Math.PI / 6, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
} as unknown as Overlay;

function draw(fn: (d: DrawContext) => void) {
  drawOverlay(spatialCode, {
    ctx: mainCtx(), width: 1920, height: 1080, fps: 30, totalFrames: 60, frame: 0, time: 0,
    duration: 2, progress: 0, assets: {},
    compiledDrawFns: { c1: fn },
    // A content box that isn't the rect → the code case adds translate + scale.
    codeContentBoxes: { c1: { x: 10, y: 10, width: 50, height: 50 } },
    spatialQuads: { c1: quad },
  } as unknown as DrawOverlayContext);
}

describe("spatial 2D overlays leave the shared scratch canvas as they found it", () => {
  it("a normal code draw: no clip or translate survives, the next clear is clean", () => {
    draw(() => {});
    expect(scratch.stack).toHaveLength(0);
    expect(scratch.clip).toBeNull();
    expect(scratch.tx).toBe(0);
    draw(() => {});
    expect(scratch.clears.at(-1)).toEqual({ clip: null, tx: 0 });
  });

  it("a code body that throws after its own save + clip leaves nothing behind", () => {
    expect(() =>
      draw((d) => {
        d.ctx.save();
        d.ctx.beginPath();
        d.ctx.rect(0, 0, 5, 5);
        d.ctx.clip();
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(scratch.stack).toHaveLength(0);
    expect(scratch.clip).toBeNull();
    expect(scratch.tx).toBe(0);
  });
});
