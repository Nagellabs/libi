// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderFrame } from "@/lib/engine/renderer";
import type { Composition } from "@/lib/engine/types";
import type { LayerSource } from "@/lib/engine/layer-source";
import { fakeBitmap, fakeLayers } from "@/__tests__/helpers/fake-layers";

/**
 * QA 2026-09-18 N1: when a code overlay's body threw, `drawOverlay`'s own
 * `ctx.save()` + clip-to-rect was never restored (the renderer's catch only
 * reset globalAlpha). Every later draw — the rest of the frame AND the next
 * frame's clearRect/base video — was clipped to that overlay's rect, so the
 * export showed the base video frozen outside it. The stack also grew by one
 * per frame.
 *
 * The stub below keeps a real Canvas2D-shaped state stack: `save` pushes the
 * current clip, `restore` pops it (a no-op when empty, like the real thing),
 * `clip` intersects with the last `rect`. Every clearRect / fillRect / draw
 * records the clip in force when it ran.
 *
 * Bodies render in the sandbox now (spec §4.4) and never touch this ctx; the
 * host-side hazards left are a LayerSource that throws, and any host draw step
 * that leaves save/clip unbalanced — `misbehaving` below stands in for the
 * latter by touching the ctx from inside `get`.
 */
type Rect = { x: number; y: number; w: number; h: number };

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}

function trackingCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = 100;
  canvas.height = 100;
  const stack: Array<Rect | null> = [];
  let clip: Rect | null = null;
  let pendingRect: Rect | null = null;
  const log: Array<{ op: string; clip: Rect | null }> = [];
  const record = (op: string) => () => { log.push({ op, clip }); };
  const ctx = {
    save: () => { stack.push(clip); },
    restore: () => { if (stack.length) clip = stack.pop() ?? null; },
    beginPath: () => { pendingRect = null; },
    rect: (x: number, y: number, w: number, h: number) => { pendingRect = { x, y, w, h }; },
    clip: () => { if (pendingRect) clip = clip ? intersect(clip, pendingRect) : pendingRect; },
    clearRect: record("clearRect"),
    fillRect: record("fillRect"),
    drawImage: record("drawImage"),
    fillText: record("fillText"),
    strokeText: record("strokeText"),
    setTransform: vi.fn(), translate: vi.fn(), scale: vi.fn(), rotate: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
    font: "", textAlign: "left", textBaseline: "alphabetic",
    fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, lineJoin: "round",
    filter: "none", globalAlpha: 1, shadowColor: "", shadowBlur: 0,
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(canvas, "getContext").mockReturnValue(ctx as never);
  return { canvas, ctx, stack, log, currentClip: () => clip };
}

function codeOverlay(id: string, z: number, rect = { x: 10, y: 10, width: 30, height: 30 }) {
  return { id, kind: "code" as const, startTime: 0, duration: 2, z, rect, opacity: 1, drawFunction: "" };
}

/** A LayerSource whose `get` runs `fn` on the frame's ctx — a stand-in for a
 *  host draw step that leaves the state stack unbalanced. */
function misbehaving(ctx: CanvasRenderingContext2D, fn: (ctx: CanvasRenderingContext2D) => void): LayerSource {
  return {
    request() {},
    get() {
      fn(ctx);
      return null;
    },
  };
}

function comp(overlays: ReturnType<typeof codeOverlay>[]): Composition {
  return { id: "c", name: "c", width: 100, height: 100, fps: 30, overlays };
}

describe("renderFrame keeps the canvas state stack balanced per overlay", () => {
  it("a throwing overlay leaves no save/clip behind; the next frame clears unclipped", () => {
    const { canvas, stack, log, currentClip } = trackingCanvas();
    const layers = fakeLayers({}, { throwOnGet: ["bad"] });
    const c = comp([codeOverlay("bad", 0)]);

    renderFrame(canvas, c, 0, {}, undefined, undefined, layers);
    expect(stack).toHaveLength(0);
    expect(currentClip()).toBeNull();

    log.length = 0;
    renderFrame(canvas, c, 1, {}, undefined, undefined, layers);
    const clear = log.find((e) => e.op === "clearRect");
    expect(clear?.clip).toBeNull();
    expect(stack).toHaveLength(0);
  });

  it("a later overlay in the same frame draws with only its OWN clip", () => {
    const { canvas, log } = trackingCanvas();
    const layers = fakeLayers({ good: fakeBitmap() }, { throwOnGet: ["bad"] });
    const c = comp([
      codeOverlay("bad", 0, { x: 10, y: 10, width: 30, height: 30 }),
      codeOverlay("good", 1, { x: 50, y: 50, width: 20, height: 20 }),
    ]);
    renderFrame(canvas, c, 0, {}, undefined, undefined, layers);
    expect(layers.requests.filter((r) => r.overlayId === "good")).toHaveLength(1);
    const draw = log.filter((e) => e.op === "drawImage").at(-1);
    expect(draw?.clip).toEqual({ x: 50, y: 50, w: 20, h: 20 });
  });

  it("a draw that throws after pushing its OWN save+clip is unwound too", () => {
    const { canvas, ctx, stack, currentClip } = trackingCanvas();
    const layers = misbehaving(ctx, (c) => {
      c.save();
      c.save();
      c.beginPath();
      c.rect(0, 0, 5, 5);
      c.clip();
      throw new Error("mid-draw");
    });
    renderFrame(canvas, comp([codeOverlay("bad", 0)]), 0, {}, undefined, undefined, layers);
    expect(stack).toHaveLength(0);
    expect(currentClip()).toBeNull();
  });

  it("a draw that returns with an unbalanced save (no throw) is unwound too", () => {
    const { canvas, ctx, stack, currentClip } = trackingCanvas();
    const layers = misbehaving(ctx, (c) => {
      c.save();
      c.beginPath();
      c.rect(0, 0, 5, 5);
      c.clip();
    });
    renderFrame(canvas, comp([codeOverlay("leaky", 0)]), 0, {}, undefined, undefined, layers);
    expect(stack).toHaveLength(0);
    expect(currentClip()).toBeNull();
  });

  it("a draw that over-restores cannot pop state it didn't push", () => {
    const { canvas, ctx, stack } = trackingCanvas();
    // Simulate a caller that holds its own saved state around the frame.
    ctx.save();
    const layers = misbehaving(ctx, (c) => { c.restore(); c.restore(); c.restore(); });
    renderFrame(canvas, comp([codeOverlay("greedy", 0)]), 0, {}, undefined, undefined, layers);
    expect(stack).toHaveLength(1);
  });
});
