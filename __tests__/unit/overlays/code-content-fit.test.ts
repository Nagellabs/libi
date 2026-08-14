import { describe, it, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  contentFitOps,
  measureCodeContentBox,
  type ContentBox,
} from "@/lib/overlays/code-content-fit";

// Inject a real (@napi-rs) canvas so the probe can actually rasterize + read
// back pixels in the node test environment (jsdom/node has no real canvas).
const makeCanvas = (w: number, h: number) =>
  createCanvas(w, h) as unknown as OffscreenCanvas;

type Ctx = { ctx: CanvasRenderingContext2D; progress?: number };

describe("contentFitOps", () => {
  it("scales a small centered box UP and centers it (100x100 in 400x200 → scale 2)", () => {
    const box: ContentBox = { x: 0, y: 0, width: 100, height: 100 };
    const fit = contentFitOps(box, 400, 200);
    // scale = min(400/100, 200/100) = 2
    // dx = (400 - 100*2)/2 - 0*2 = 100 ; dy = (200 - 100*2)/2 - 0*2 = 0
    expect(fit).toEqual({ scale: 2, dx: 100, dy: 0 });
  });

  it("accounts for the box origin in dx/dy (offset box)", () => {
    const box: ContentBox = { x: 50, y: 20, width: 100, height: 100 };
    const fit = contentFitOps(box, 400, 200);
    // scale 2 ; dx = (400-200)/2 - 50*2 = 0 ; dy = (200-200)/2 - 20*2 = -40
    expect(fit).toEqual({ scale: 2, dx: 0, dy: -40 });
  });

  it("returns identity when the box equals the rect (compat guarantee)", () => {
    const box: ContentBox = { x: 0, y: 0, width: 400, height: 200 };
    expect(contentFitOps(box, 400, 200)).toEqual({ scale: 1, dx: 0, dy: 0 });
  });

  it("scales content LARGER than the rect DOWN (contain-fit both directions)", () => {
    const box: ContentBox = { x: 0, y: 0, width: 800, height: 400 };
    // scale = min(400/800, 200/400) = 0.5
    expect(contentFitOps(box, 400, 200)).toEqual({ scale: 0.5, dx: 0, dy: 0 });
  });

  it("returns identity for a degenerate zero-size box", () => {
    expect(contentFitOps({ x: 0, y: 0, width: 0, height: 0 }, 400, 200)).toEqual({
      scale: 1,
      dx: 0,
      dy: 0,
    });
  });
});

describe("measureCodeContentBox", () => {
  it("measures the alpha bbox of a fixed square drawn by the fn", () => {
    const fn = (c: Ctx) => {
      c.ctx.fillStyle = "#ffffff";
      c.ctx.fillRect(10, 20, 40, 40);
    };
    const box = measureCodeContentBox(fn as never, 200, 100, makeCanvas);
    expect(box).toEqual({ x: 10, y: 20, width: 40, height: 40 });
  });

  it("returns null when the fn draws nothing at any sample (degenerate)", () => {
    const fn = () => {
      /* draws nothing */
    };
    expect(measureCodeContentBox(fn as never, 200, 100, makeCanvas)).toBeNull();
  });

  it("returns null (identity fallback) when the fn throws", () => {
    const fn = () => {
      throw new Error("boom");
    };
    expect(measureCodeContentBox(fn as never, 200, 100, makeCanvas)).toBeNull();
  });

  it("captures content that only draws at progress 1 (samples include 1)", () => {
    const fn = (c: Ctx) => {
      if ((c.progress ?? 0) >= 1) {
        c.ctx.fillStyle = "#ffffff";
        c.ctx.fillRect(5, 5, 10, 10);
      }
    };
    const box = measureCodeContentBox(fn as never, 200, 100, makeCanvas);
    expect(box).toEqual({ x: 5, y: 5, width: 10, height: 10 });
  });

  it("unions the ink bbox across animated samples (moving content stays inside)", () => {
    // A dot that moves left→right AND clears every frame — only the union of all
    // sample positions gives a box wide enough to contain the whole animation.
    const fn = (c: Ctx) => {
      c.ctx.clearRect(0, 0, 200, 100);
      c.ctx.fillStyle = "#ffffff";
      const p = c.progress ?? 0;
      const x = Math.round(p * 100); // 0,25,50,75,100 across samples
      c.ctx.fillRect(x, 40, 10, 10);
    };
    const box = measureCodeContentBox(fn as never, 200, 100, makeCanvas);
    // union spans x∈[0,110) (first dot at 0, last at 100 width 10) → x0=0, x1=109
    expect(box).not.toBeNull();
    expect(box!.x).toBe(0);
    expect(box!.width).toBe(110);
    expect(box!.y).toBe(40);
    expect(box!.height).toBe(10);
  });

  it("returns null without a real canvas (no OffscreenCanvas, no factory)", () => {
    const fn = (c: Ctx) => c.ctx.fillRect(0, 0, 10, 10);
    // No makeCanvas + node has no OffscreenCanvas → cannot probe → null.
    expect(measureCodeContentBox(fn as never, 200, 100)).toBeNull();
  });
});
