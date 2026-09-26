// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { LayerEngine, IDLE_LAYER_MS } from "@/lib/sandbox/runtime/layers";
import { BodyError } from "@/lib/sandbox/runtime/compile";
import type { LoadMessage, RenderMessage } from "@/lib/sandbox/protocol";
import type { Overlay } from "@/lib/engine/types";
import { planLayer } from "@/lib/engine/overlay-renderer";
import type { ThreeOverlayInstance } from "@/lib/engine/three-overlay";
import { probeFrames } from "@/lib/overlays/code-content-fit";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function fakeCanvas(w: number, h: number) {
  const ctx = {
    save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), clearRect: vi.fn(), translate: vi.fn(), scale: vi.fn(),
    fillRect: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(w * h * 4) })),
    font: "", fillStyle: "", globalAlpha: 1,
  };
  const canvas = {
    width: w, height: h, ctx,
    getContext: () => ctx,
    transferToImageBitmap: () => ({ width: canvas.width, height: canvas.height, close: vi.fn(), from: "layer" }),
  };
  return canvas;
}

/** A fake canvas whose integer `fillRect`s really ink its alpha channel, so
 *  the real content-fit probe can measure through it. */
function inkCanvas(w: number, h: number) {
  const c = fakeCanvas(w, h);
  const px = new Uint8ClampedArray(w * h * 4);
  c.ctx.clearRect = vi.fn(() => px.fill(0));
  c.ctx.fillRect = vi.fn((x: number, y: number, rw: number, rh: number) => {
    for (let yy = Math.max(0, y); yy < Math.min(h, y + rh); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(w, x + rw); xx++) px[(yy * w + xx) * 4 + 3] = 255;
  });
  c.ctx.getImageData = vi.fn(() => ({ data: px }));
  return c;
}

let now = 0;
function engine(extra: Partial<ConstructorParameters<typeof LayerEngine>[0]> = {}) {
  const canvases: ReturnType<typeof fakeCanvas>[] = [];
  const e = new LayerEngine({
    makeCanvas: (w, h) => { const c = fakeCanvas(w, h); canvases.push(c); return c as unknown as OffscreenCanvas; },
    now: () => now,
    wrapperLineOffset: 2,
    installFont: vi.fn(async () => {}),
    ...extra,
  });
  return { e, canvases };
}

const timing = { frame: 6, time: 0.2, totalFrames: 90, duration: 3, progress: 0.0667 };
const load = (over: Partial<LoadMessage> = {}): LoadMessage => ({
  t: "load", id: "o1", kind: "code", source: "context.ctx.fillRect(0,0,context.width,context.height);", sourceHash: HASH_A, width: 200, height: 100, ...over,
});
const render = (over: Partial<RenderMessage> = {}): RenderMessage => ({
  t: "render", id: "o1", frame: 6, req: 1, size: { width: 200, height: 100 }, pixelRatio: 2, fps: 30, time: timing, ...over,
});

describe("LayerEngine — code layers", () => {
  it("compiles on load, renders into a pixelRatio-scaled OffscreenCanvas and returns the bitmap", async () => {
    const seen: unknown[] = [];
    const { e, canvases } = engine();
    await e.load(load({ source: "__seen.push(context);" }));
    expect(e.stats.compiles).toBe(1);
    // The body can't see our test scope, so route through a helper-shaped global.
    (globalThis as unknown as { __seen: unknown[] }).__seen = seen;
    const bmp = e.render(render());
    expect((bmp as unknown as { from: string }).from).toBe("layer");
    const layer = canvases[0];
    expect([layer.width, layer.height]).toEqual([400, 200]);
    expect(layer.ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    expect(layer.ctx.clearRect).toHaveBeenCalledWith(0, 0, 400, 200);
    // The contain-fit probe sweeps the overlay's own timeline first (one call
    // per probe frame on its own throwaway canvas; this fake canvas reads back
    // no ink, so there is no early exit), and the LAST call paints this frame.
    expect(seen).toHaveLength(probeFrames(timing.totalFrames).length + 1);
    const c = seen[seen.length - 1] as Record<string, unknown>;
    expect(Object.keys(c).sort()).toEqual(["ctx", "duration", "fps", "frame", "height", "images", "progress", "time", "totalFrames", "width"]);
    expect(c.width).toBe(200);
    expect(c.frame).toBe(6);
  });
  it("does not recompile for the same sourceHash, recompiles for a new one", async () => {
    const { e } = engine();
    await e.load(load());
    await e.load(load());
    expect(e.stats.compiles).toBe(1);
    await e.load(load({ source: "1;", sourceHash: HASH_B }));
    expect(e.stats.compiles).toBe(2);
  });
  it("applies the contain-fit for plain code layers, never for tracked ones", async () => {
    const measure = vi.fn(() => ({ x: 10, y: 10, width: 50, height: 50 }));
    const { e, canvases } = engine({ measureContentBox: measure as never });
    await e.load(load());
    e.render(render());
    // contentFitOps({10,10,50,50}, 200, 100) → scale 2, dx = (200-100)/2 - 20 = 30, dy = (100-100)/2 - 20 = -20
    expect(canvases[0].ctx.translate).toHaveBeenCalledWith(30, -20);
    expect(canvases[0].ctx.scale).toHaveBeenCalledWith(2, 2);
    expect(measure).toHaveBeenCalledTimes(1);
    e.render(render({ req: 2 }));
    expect(measure).toHaveBeenCalledTimes(1); // cached per size
    e.render(render({ req: 3, size: { width: 300, height: 100 } }));
    expect(measure).toHaveBeenCalledTimes(2); // re-probed on resize

    await e.load(load({ id: "t1", kind: "tracked" }));
    e.render(render({ id: "t1", req: 4 }));
    expect(measure).toHaveBeenCalledTimes(2);
  });
  it("probes over the render's REAL timeline, and re-probes when the overlay is retimed (bug 1, 2026-09-25)", async () => {
    // The probe used to fabricate a 1 s timeline, so a body whose content
    // enters at t = 2 s was fitted to a fraction of itself and zoomed.
    const measure = vi.fn(() => ({ x: 0, y: 0, width: 200, height: 100 }));
    const timelineOf = (call: number) => (measure.mock.calls[call] as unknown[])[3];
    const { e } = engine({ measureContentBox: measure as never });
    await e.load(load());
    e.render(render());
    expect(timelineOf(0)).toEqual({ fps: 30, totalFrames: 90, duration: 3 });
    // Another frame on the same timeline: cached.
    e.render(render({ req: 2, frame: 40, time: { ...timing, frame: 40, time: 1.333, progress: 0.444 } }));
    expect(measure).toHaveBeenCalledTimes(1);
    // Trimmed to 6 s: a new timeline, measured again over IT.
    e.render(render({ req: 3, time: { ...timing, totalFrames: 180, duration: 6, progress: 0.0333 } }));
    expect(measure).toHaveBeenCalledTimes(2);
    expect(timelineOf(1)).toEqual({ fps: 30, totalFrames: 180, duration: 6 });
    // A new fps is a new timeline too.
    e.render(render({ req: 4, fps: 60, time: { ...timing, totalFrames: 360, duration: 6, progress: 0.0333 } }));
    expect(measure).toHaveBeenCalledTimes(3);
  });
  it("a real body whose content enters at 2 s is fitted by its full extent, end to end through the engine", async () => {
    // Real probe (no injected measure) on the fake canvases, whose readback is
    // blank — so drive it through a canvas that records ink per fillRect.
    const canvases: ReturnType<typeof fakeCanvas>[] = [];
    const e = new LayerEngine({
      makeCanvas: (w, h) => { const c = inkCanvas(w, h); canvases.push(c); return c as unknown as OffscreenCanvas; },
      now: () => now,
      wrapperLineOffset: 2,
      installFont: vi.fn(async () => {}),
    });
    await e.load(load({ source: "const c = context.ctx; c.fillRect(20, 20, 100, 20); if (context.time >= 2) c.fillRect(20, 60, 160, 30);" }));
    e.render(render({ time: { frame: 0, time: 0, totalFrames: 300, duration: 10, progress: 0 } }));
    // Box {20,20,160,70} in 200×100 → scale 1.25, dx = (200-200)/2 - 25 = -25, dy = (100-87.5)/2 - 25 = -18.75.
    // (The old 1 s probe saw only the title: scale 1.43 → the row ran off the right edge.)
    expect(canvases[0].ctx.scale).toHaveBeenCalledWith(1.25, 1.25);
    expect(canvases[0].ctx.translate).toHaveBeenCalledWith(-25, -18.75);
  });
  it("a slow body (300 ms/frame) renders its first frame well inside the 5 s first-render budget: the probe keeps its own", async () => {
    // Review I1: 17 probe calls + the paint = 5.4 s of body time, past the
    // watchdog's 5 s. The probe keeps its own budget on the engine's clock,
    // past the five coarse frames it always paints.
    const debug = vi.fn();
    const calls: number[] = [];
    (globalThis as unknown as { __slow: (f: number) => void }).__slow = (f) => { now += 300; calls.push(f); };
    const { e } = engine({ debug });
    await e.load(load({ source: "__slow(context.frame); context.ctx.fillRect(10, 10, 20, 20);" }));
    const t0 = now;
    e.render(render({ time: { frame: 0, time: 0, totalFrames: 300, duration: 10, progress: 0 } }));
    const spent = now - t0;
    // The first sample + max(4 samples, the 1.5 s budget) + the paint.
    expect(spent).toBeLessThanOrEqual(300 + Math.max(4 * 300, 1500) + 300);
    // The five coarse frames came first, whatever the budget did after them.
    expect(calls.slice(0, 5)).toEqual([0, 299, 150, 75, 224]);
    // Reported once, at debug, tagged.
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0][1]).toMatchObject({ tag: "overlay-sandbox", op: "fit_probe_budget", id: "o1", planned: 17, budgetMs: 1500 });
    // Later frames reuse the fit: one body call each, nothing more logged.
    e.render(render({ req: 2, frame: 30, time: { frame: 30, time: 1, totalFrames: 300, duration: 10, progress: 0.1 } }));
    expect(now - t0 - spent).toBe(300);
    expect(debug).toHaveBeenCalledTimes(1);
  });
  describe("layouts that are NOT affine in the rect size (M11, re-review 2): no ink leaves the rect at any frame of the tween", () => {
    /** The ink a body source lays down at a size, by running it on a recorder. */
    function inkBounds(source: string, width: number, height: number) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const ctx = { fillRect: (x: number, y: number, w: number, h: number) => {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
      } };
      new Function("context", source)({ ctx, width, height, time: 0, frame: 0, fps: 30, totalFrames: 90, duration: 3, progress: 0 });
      return { x0, y0, x1, y1 };
    }
    async function tween(source: string, fromSize: { width: number; height: number }, toSize: { width: number; height: number }) {
      const r0 = { x: 0, y: 0, ...fromSize };
      const overlay = {
        id: "o1", kind: "code", startTime: 0, duration: 3, z: 0, opacity: 1, drawFunction: "", rect: r0,
        keyframes: { rect: { keyframes: [{ t: 0, value: r0 }, { t: 1, value: { x: 0, y: 0, ...toSize } }] } },
      } as unknown as Overlay;
      const canvases: ReturnType<typeof fakeCanvas>[] = [];
      const e = new LayerEngine({
        makeCanvas: (w, h) => { const c = inkCanvas(w, h); canvases.push(c); return c as unknown as OffscreenCanvas; },
        now: () => now, wrapperLineOffset: 2, installFont: vi.fn(async () => {}),
      });
      await e.load(load({ source }));
      let req = 0;
      const frames: { width: number; height: number; scale: number; dx: number; dy: number }[] = [];
      for (let f = 0; f < 90; f++) {
        const { overlayId, kind, ...rest } = planLayer(overlay, { time: f / 30, fps: 30, width: 1920, height: 1080, renderScale: 1 })!.request;
        void kind;
        const layer = canvases[0];
        layer.ctx.scale.mockClear();
        layer.ctx.translate.mockClear();
        e.render({ t: "render", id: overlayId, req: ++req, ...rest } as RenderMessage);
        frames.push({
          ...rest.size,
          scale: layer.ctx.scale.mock.calls[0]?.[0] ?? 1,
          dx: layer.ctx.translate.mock.calls[0]?.[0] ?? 0,
          dy: layer.ctx.translate.mock.calls[0]?.[1] ?? 0,
        });
      }
      return { frames, probes: canvases.length - 1 };
    }
    function expectInside(source: string, frames: { width: number; height: number; scale: number; dx: number; dy: number }[]) {
      for (const f of frames) {
        const ink = inkBounds(source, f.width, f.height);
        expect(f.dx + ink.x0 * f.scale).toBeGreaterThanOrEqual(-1e-6);
        expect(f.dy + ink.y0 * f.scale).toBeGreaterThanOrEqual(-1e-6);
        expect(f.dx + ink.x1 * f.scale).toBeLessThanOrEqual(f.width + 1e-6);
        expect(f.dy + ink.y1 * f.scale).toBeLessThanOrEqual(f.height + 1e-6);
      }
    }

    it("a ring of radius 0.4 · min(width, height), 400×600 → 800×600: plain interpolation cut 20 % off it at the midpoint", async () => {
      const ring = `const W = context.width, H = context.height, r = Math.round(0.4 * Math.min(W, H));
context.ctx.fillRect(Math.round(W / 2) - r, Math.round(H / 2) - r, 2 * r, 2 * r);`;
      const { frames, probes } = await tween(ring, { width: 400, height: 600 }, { width: 800, height: 600 });
      expectInside(ring, frames);
      // The kink sits exactly at the 600 midpoint: both halves are affine, so
      // 400, 800, 600 and one agreeing midpoint per half — five fits, not 90.
      expect(probes).toBeLessThanOrEqual(5);
    });

    it("text wrapped to the width (fixed-size words, greedy lines), 300 → 800 px: every frame's ink stays inside", async () => {
      const wrapped = `const W = context.width, words = 14, wordW = 70, gap = 10, lineH = 30, pad = 20;
let x = pad, y = pad;
for (let i = 0; i < words; i++) {
  if (x > pad && x + wordW > W - pad) { x = pad; y += lineH; }
  context.ctx.fillRect(x, y, wordW, 20);
  x += wordW + gap;
}`;
      const { frames, probes } = await tween(wrapped, { width: 300, height: 400 }, { width: 800, height: 400 });
      expectInside(wrapped, frames);
      // Re-wrapping bends in steps nothing can interpolate, so where an eighth
      // of the segment still disagrees each frame is measured at its own size
      // — what every frame cost before the tween path existed. Never more than
      // that plus the path's fixed fits (2 ends + 1 + 2 + 4 midpoints).
      expect(probes).toBeLessThanOrEqual(90 + 9);
    });

    it("an affine body still costs its segment three fits (ends + one agreeing midpoint)", async () => {
      const block = "context.ctx.fillRect(Math.round((context.width - 300) / 2), 20, 300, 60);";
      const { frames, probes } = await tween(block, { width: 400, height: 100 }, { width: 800, height: 100 });
      expectInside(block, frames);
      expect(probes).toBe(3);
    });
  });

  it("the fit does not depend on the worker's warm-up: a cold first call (preview vs export chunk) measures the same box (review I2)", async () => {
    const body = "__tick(); const c = context.ctx; c.fillRect(20, 20, 20, 20); if (context.time >= 4.5 && context.time < 5.5) c.fillRect(100, 60, 80, 30);";
    async function fitWith(warmUpMs: number) {
      let first = true;
      (globalThis as unknown as { __tick: () => void }).__tick = () => { now += first ? warmUpMs : 5; first = false; };
      const canvases: ReturnType<typeof fakeCanvas>[] = [];
      const e = new LayerEngine({
        makeCanvas: (w, h) => { const c = inkCanvas(w, h); canvases.push(c); return c as unknown as OffscreenCanvas; },
        now: () => now, wrapperLineOffset: 2, installFont: vi.fn(async () => {}),
      });
      await e.load(load({ source: body }));
      e.render(render({ time: { frame: 0, time: 0, totalFrames: 300, duration: 10, progress: 0 } }));
      return { scale: canvases[0].ctx.scale.mock.calls[0], translate: canvases[0].ctx.translate.mock.calls[0] };
    }
    const warm = await fitWith(5);
    // Box {20,20,160,70} (the mid-timeline block included) → scale 1.25.
    expect(warm.scale).toEqual([1.25, 1.25]);
    expect(await fitWith(1600)).toEqual(warm);
    expect(await fitWith(5000)).toEqual(warm);
  });
  it("a probe stopped by its budget is reported once through the injected measure's onBudgetStop, and the partial box is used", async () => {
    const measure = vi.fn((_fn: unknown, _w: number, _h: number, _t: unknown, opts: { onBudgetStop?: (s: unknown) => void }) => {
      opts.onBudgetStop?.({ sampled: 3, planned: 17, elapsedMs: 1600, budgetMs: 1500 });
      return { x: 10, y: 10, width: 50, height: 50 };
    });
    const { e, canvases } = engine({ measureContentBox: measure as never });
    await e.load(load());
    e.render(render());
    e.render(render({ req: 2 }));
    expect(measure).toHaveBeenCalledTimes(1);
    expect(canvases[0].ctx.scale).toHaveBeenCalledWith(2, 2);
    const opts = (measure.mock.calls[0] as unknown[])[4] as { now?: () => number; budgetMs?: number };
    expect(typeof opts.now).toBe("function");
  });
  it("the probe sees the render's caption words, and new words re-probe", async () => {
    const seenWords: unknown[] = [];
    (globalThis as unknown as { __words: (w: unknown) => void }).__words = (w) => seenWords.push(w);
    const { e } = engine();
    await e.load(load({ source: "__words(context.words);" }));
    const words = [{ text: "hi", start: 0, end: 0.5 }];
    e.render(render({ words }));
    const probeCalls = seenWords.length - 1;
    expect(probeCalls).toBeGreaterThan(0);
    expect(seenWords.every((w) => JSON.stringify(w) === JSON.stringify(words))).toBe(true);
    const before = seenWords.length;
    e.render(render({ req: 2, words }));
    expect(seenWords.length).toBe(before + 1); // cached: only the paint
    e.render(render({ req: 3, words: [...words, { text: "there", start: 0.5, end: 1 }] }));
    expect(seenWords.length).toBeGreaterThan(before + 2); // re-probed
  });
  it("a 400 → 800 px width tween: the ends and midpoint are measured once each, the scale follows the tween without steps or overflow, and the hold after it is the static fit (review I3)", async () => {
    // Fixed-pixel content — the case per-bucket measuring stepped and clipped.
    const body = "context.ctx.fillRect(Math.round((context.width - 300) / 2), 20, 300, 60);";
    const r400 = { x: 0, y: 0, width: 400, height: 100 };
    const overlay = {
      id: "o1", kind: "code", startTime: 0, duration: 3, z: 0, opacity: 1, drawFunction: "", rect: r400,
      keyframes: { rect: { keyframes: [{ t: 0, value: r400 }, { t: 0.5, value: { ...r400, width: 800 } }] } },
    } as unknown as Overlay;
    function run(o: Overlay, frames: number[]) {
      const canvases: ReturnType<typeof fakeCanvas>[] = [];
      const e = new LayerEngine({
        makeCanvas: (w, h) => { const c = inkCanvas(w, h); canvases.push(c); return c as unknown as OffscreenCanvas; },
        now: () => now, wrapperLineOffset: 2, installFont: vi.fn(async () => {}),
      });
      return (async () => {
        await e.load(load({ source: body }));
        const out: { width: number; scale: number; dx: number }[] = [];
        let req = 0;
        for (const f of frames) {
          const { overlayId, kind, ...rest } = planLayer(o, { time: f / 30, fps: 30, width: 1920, height: 1080, renderScale: 1 })!.request;
          void kind;
          const layer = canvases[0];
          layer.ctx.scale.mockClear();
          layer.ctx.translate.mockClear();
          e.render({ t: "render", id: overlayId, req: ++req, ...rest } as RenderMessage);
          const sc = layer.ctx.scale.mock.calls[0]?.[0] ?? 1;
          const dx = layer.ctx.translate.mock.calls[0]?.[0] ?? 0;
          out.push({ width: rest.size.width, scale: sc, dx });
        }
        return { out, probes: canvases.length - 1 };
      })();
    }
    const frames = Array.from({ length: 90 }, (_, f) => f);
    const { out, probes } = await run(overlay, frames);
    // 400, 800 and the 600 midpoint (which agrees: the body is affine in the
    // size), once each — not one per frame of the tween.
    expect(probes).toBe(3);
    let prev = 0;
    for (const { width, scale, dx } of out) {
      // Monotone through the grow, to within the block's one-pixel quantum.
      expect(scale).toBeGreaterThan(prev * (1 - 1 / 300) - 1e-12);
      prev = scale;
      // Tracks the fit an exact per-frame probe would give — to that same
      // pixel, never the ~9 % hold-then-jump of per-bucket measuring.
      const exact = (await run({ ...overlay, rect: { ...r400, width }, keyframes: undefined } as unknown as Overlay, [0])).out[0];
      expect(Math.abs(scale - exact.scale) / exact.scale).toBeLessThanOrEqual(1 / 300 + 1e-9);
      // The block as the body draws it at this size lands inside the rect.
      const left = dx + Math.round((width - 300) / 2) * scale;
      expect(left).toBeGreaterThanOrEqual(-1e-6);
      expect(left + 300 * scale).toBeLessThanOrEqual(width + 1e-6);
    }
    // Scrubbing back over the tween re-probes nothing (the LRU holds both ends).
    const again = await run(overlay, [...frames, ...frames.slice().reverse()]);
    expect(again.probes).toBe(3);
    // The hold after the tween fits exactly as a static 800 px rect does.
    const still = await run({ ...overlay, rect: { ...r400, width: 800 }, keyframes: undefined } as unknown as Overlay, [60]);
    expect(out[89]).toEqual(still.out[0]);
    expect(out[45]).toEqual(still.out[0]);
  });
  it("load never RUNS the body: the contain-fit probe belongs to the render path (spec \u00a74.7)", async () => {
    // A body is executed for the first time when a frame is asked for, so a
    // body that never returns wedges the 2 s RENDER watchdog. Probing the
    // content box at load time instead moved that wedge onto the 5 s LOAD
    // watchdog and rejected the host's `load` promise for a body that had
    // compiled perfectly well \u2014 measured live, 2026-09-23, with
    // `while (true) {}`.
    const measure = vi.fn(() => ({ x: 10, y: 10, width: 50, height: 50 }));
    const ran = vi.fn();
    (globalThis as unknown as { __ran: () => void }).__ran = ran;
    const { e } = engine({ measureContentBox: measure as never });
    await e.load(load({ source: "__ran();" }));
    expect(measure).not.toHaveBeenCalled();
    expect(ran).not.toHaveBeenCalled();
    e.render(render());
    expect(measure).toHaveBeenCalledTimes(1);
    expect(ran).toHaveBeenCalled();
  });

  it("a box equal to the rect is identity: no translate/scale", async () => {
    const measure = vi.fn(() => ({ x: 0, y: 0, width: 200, height: 100 }));
    const { e, canvases } = engine({ measureContentBox: measure as never });
    await e.load(load());
    e.render(render());
    expect(canvases[0].ctx.translate).not.toHaveBeenCalled();
    expect(canvases[0].ctx.scale).not.toHaveBeenCalled();
  });
  it("a probe that finds no ink, or a zero-area box, is identity: no translate/scale (review M4)", async () => {
    // Replaces the host-side null-box case deleted with code-content-fit-render.test.ts.
    for (const box of [null, { x: 20, y: 20, width: 0, height: 30 }]) {
      const measure = vi.fn(() => box);
      const { e, canvases } = engine({ measureContentBox: measure as never });
      await e.load(load());
      e.render(render());
      expect(measure).toHaveBeenCalledTimes(1);
      expect(canvases[0].ctx.translate).not.toHaveBeenCalled();
      expect(canvases[0].ctx.scale).not.toHaveBeenCalled();
    }
  });
  it("a padded tracked layer covers box + pad, offsets the body by the pad, and keeps the body's width/height (review I1)", async () => {
    const seen: Record<string, unknown>[] = [];
    (globalThis as unknown as { __seen: unknown[] }).__seen = seen;
    const { e, canvases } = engine();
    await e.load(load({ id: "t1", kind: "tracked", source: "__seen.push(context);" }));
    e.render(render({ id: "t1", size: { width: 80, height: 60 }, pad: { left: 80, top: 40, right: 20, bottom: 0 } }));
    const layer = canvases[0];
    // (80 + 80 + 20) × (40 + 60 + 0) composition px at pixelRatio 2.
    expect([layer.width, layer.height]).toEqual([360, 200]);
    expect(layer.ctx.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0);
    expect(layer.ctx.translate).toHaveBeenCalledWith(80, 40);
    expect(seen).toHaveLength(1); // tracked: no contain-fit probe
    expect([seen[0].width, seen[0].height]).toEqual([80, 60]);
  });
  it("an unpadded layer is not translated", async () => {
    const { e, canvases } = engine();
    await e.load(load({ id: "t1", kind: "tracked" }));
    e.render(render({ id: "t1", size: { width: 80, height: 60 } }));
    expect([canvases[0].width, canvases[0].height]).toEqual([160, 120]);
    expect(canvases[0].ctx.translate).not.toHaveBeenCalled();
  });
  it("throws BodyError(compile) for a broken body and BodyError(render) with a line for a throwing one", async () => {
    const { e } = engine();
    await expect(e.load(load({ source: "this is (", sourceHash: HASH_B }))).rejects.toBeInstanceOf(BodyError);
    await e.load(load({ source: "const x = 1;\nnope();" }));
    let caught: BodyError | null = null;
    try { e.render(render()); } catch (err) { caught = err as BodyError; }
    expect(caught?.phase).toBe("render");
    expect(caught?.line).toBe(2);
  });
  it("rendering an unloaded id is a render-phase BodyError", () => {
    const { e } = engine();
    expect(() => e.render(render({ id: "ghost" }))).toThrow(/not loaded/);
  });
  it("evicts layers idle for 60 s (canvas shrinks, body stays compiled)", async () => {
    const { e, canvases } = engine();
    await e.load(load());
    e.render(render());
    now += IDLE_LAYER_MS + 1;
    expect(e.evictIdle()).toBe(1);
    expect([canvases[0].width, canvases[0].height]).toEqual([1, 1]);
    e.render(render({ req: 2 }));
    expect([canvases[0].width, canvases[0].height]).toEqual([400, 200]);
    expect(e.stats.compiles).toBe(1);
  });
  it("installs each font once", async () => {
    const installFont = vi.fn(async () => {});
    const { e } = engine({ installFont });
    const fonts = [{ family: "Inter", weight: 700, data: new ArrayBuffer(2) }, { family: "Inter", weight: 700, data: new ArrayBuffer(2) }];
    await e.load(load({ fonts }));
    await e.load(load({ id: "o2", fonts }));
    expect(installFont).toHaveBeenCalledTimes(1);
  });
  it("a font whose install fails does not fail the load, is reported, and is retried by the next load (review I1)", async () => {
    // A corrupt or unsupported font the user uploaded: FontFace.load() rejects.
    // Recording it as installed BEFORE the await meant it was never retried.
    const installFont = vi.fn(async (): Promise<void> => { throw new Error("A network error occurred."); });
    const { e } = engine({ installFont });
    const fonts = [{ family: "Broken", weight: 400, data: new ArrayBuffer(2) }];
    const first = await e.load(load({ fonts }));
    expect(e.isLoaded("o1")).toBe(true); // the body loads with a fallback font
    expect(first.fontFailures).toEqual([{ family: "Broken", weight: 400, message: "A network error occurred." }]);
    installFont.mockImplementationOnce(async () => {});
    const second = await e.load(load({ id: "o2", fonts }));
    expect(installFont).toHaveBeenCalledTimes(2);
    expect(second.fontFailures).toEqual([]);
    await e.load(load({ id: "o3", fonts }));
    expect(installFont).toHaveBeenCalledTimes(2); // installed now: not again
  });
  it("a same-hash load that brings NEW images closes the old bitmaps (review minor 4)", async () => {
    const old = { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
    const fresh = { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
    const { e } = engine();
    await e.load(load({ images: { f1: old } }));
    await e.load(load({ images: { f1: fresh } }));
    expect((old as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
    expect((fresh as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled();
  });
  it("hands the body the transferred images and keeps them across a same-hash load", async () => {
    const bmp = { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
    const { e } = engine();
    await e.load(load({ source: "__seen.push(context.images);", images: { f1: bmp } }));
    const seen: unknown[] = [];
    (globalThis as unknown as { __seen: unknown[] }).__seen = seen;
    e.render(render());
    expect(seen[0]).toEqual({ f1: bmp });
    await e.load(load({ source: "__seen.push(context.images);" })); // same hash, no new images
    e.render(render({ req: 2 }));
    expect(seen[1]).toEqual({ f1: bmp });
    expect((bmp as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled();
  });
});

describe("LayerEngine — three layers", () => {
  function threeDeps() {
    const inst: ThreeOverlayInstance = {
      update: vi.fn(),
      applyTransform: vi.fn(),
      render: vi.fn(() => ({ transferToImageBitmap: () => ({ width: 1, height: 1, close: vi.fn(), from: "gl" }) }) as unknown as OffscreenCanvas),
      dispose: vi.fn(),
      ready: Promise.resolve(),
    };
    const deps = {
      acquire: vi.fn(async () => ({ renderer: {}, dispose: vi.fn() }) as never),
      release: vi.fn(),
      build: vi.fn(async () => inst),
    };
    return { deps, inst };
  }
  it("builds with the real size, updates/applies/renders per frame, releases on dispose", async () => {
    const { deps, inst } = threeDeps();
    const { e } = engine({ three: deps });
    await e.load(load({ id: "t", kind: "three", source: "return () => {};", three: { cameraPreset: "ground", pixelRatio: 1 } }));
    expect(deps.build).toHaveBeenCalledWith("return () => {};", "ground", expect.anything(), { width: 200, height: 100 }, 2, expect.any(Function));
    expect(e.stats.builds).toBe(1);
    const t3 = { position: { x: 0, y: 0, z: 1 }, rotation: { x: 0.1, y: 0, z: 0 } };
    const bmp = e.render(render({ id: "t", transform3d: t3, words: [{ text: "a", start: 0, end: 1 }] }));
    expect(inst.update).toHaveBeenCalledWith(expect.objectContaining({ frame: 6, progress: timing.progress, transform3d: t3 }));
    expect(inst.applyTransform).toHaveBeenCalledWith(t3);
    expect(inst.render).toHaveBeenCalledWith(400, 200);
    expect((bmp as unknown as { from: string }).from).toBe("gl");
    e.dispose("t");
    expect(inst.dispose).toHaveBeenCalled();
    expect(deps.release).toHaveBeenCalledWith("t");
  });
  it("a reload with a changed body releases the old renderer before acquiring again", async () => {
    const { deps } = threeDeps();
    const { e } = engine({ three: deps });
    await e.load(load({ id: "t", kind: "three", source: "return () => {};" }));
    await e.load(load({ id: "t", kind: "three", source: "return () => { 1; };", sourceHash: HASH_B }));
    expect(deps.release.mock.invocationCallOrder[0]).toBeLessThan(deps.acquire.mock.invocationCallOrder[1]);
  });
  it("a body that throws while building is a build-phase BodyError, and the renderer goes back to the pool (review minor 7)", async () => {
    const { deps } = threeDeps();
    deps.build.mockRejectedValueOnce(new BodyError("build", "boom", 4, 2));
    const { e } = engine({ three: deps });
    await expect(e.load(load({ id: "t", kind: "three", source: "throw new Error('boom')" }))).rejects.toMatchObject({ phase: "build", line: 4 });
    expect(deps.release).toHaveBeenCalledWith("t");
    expect(e.isLoaded("t")).toBe(false);
  });
  it("a renderer that will not come up is a build-phase BodyError, not an unmapped throw (review I1)", async () => {
    const { deps } = threeDeps();
    deps.acquire.mockRejectedValueOnce(new Error("Error creating WebGL context."));
    const { e } = engine({ three: deps });
    await expect(e.load(load({ id: "t", kind: "three", source: "return () => {};" }))).rejects.toMatchObject({
      phase: "build",
      message: expect.stringMatching(/WebGL context/),
    });
    expect(deps.build).not.toHaveBeenCalled();
    expect(deps.release).toHaveBeenCalledWith("t");
  });
  it("a three layer allocates no 2D canvas, and idle eviction releases its GL drawing buffer (review minor 5)", async () => {
    const { deps, inst } = threeDeps();
    const release = vi.fn();
    inst.releaseDrawingBuffer = release;
    const { e, canvases } = engine({ three: deps });
    await e.load(load({ id: "t", kind: "three", source: "return () => {};" }));
    expect(canvases).toHaveLength(0);
    e.render(render({ id: "t" }));
    now += IDLE_LAYER_MS + 1;
    expect(e.evictIdle()).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(e.evictIdle()).toBe(0); // already released: not again until it renders
    e.render(render({ id: "t", req: 2 }));
    now += IDLE_LAYER_MS + 1;
    expect(e.evictIdle()).toBe(1);
  });
});

describe("LayerEngine — Task 13 re-review 3 minors (M2, M3)", () => {
  function threeDeps() {
    const inst = (): ThreeOverlayInstance => ({
      update: vi.fn(),
      applyTransform: vi.fn(),
      render: vi.fn(() => ({ transferToImageBitmap: () => ({ width: 1, height: 1, close: vi.fn() }) }) as unknown as OffscreenCanvas),
      dispose: vi.fn(),
      ready: Promise.resolve(),
    });
    return {
      acquire: vi.fn(async () => ({ renderer: {}, dispose: vi.fn() }) as never),
      release: vi.fn(),
      build: vi.fn(async () => inst()),
    };
  }
  const proto = Object.prototype as unknown as Record<string, unknown>;

  it("M2 — dispose cancels the body's timers and closes its bitmaps even when Object.prototype says keep them", async () => {
    const cancelOwnedBy = vi.fn();
    const { e } = engine({ ownedTimers: { cancelOwnedBy } });
    const bmp = { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
    await e.load(load({ images: { img1: bmp } }));
    // What a body in the shared realm can do: every options object without
    // its own flags now reads "keep".
    proto.keepTimers = true;
    proto.keepImages = true;
    try {
      e.dispose("o1");
    } finally {
      delete proto.keepTimers;
      delete proto.keepImages;
    }
    expect(cancelOwnedBy).toHaveBeenCalledWith("o1");
    expect((bmp as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
  });

  it("M3 — a same-hash rebuild of a THREE body (a new camera preset) cancels the old instance's timers", async () => {
    const cancelOwnedBy = vi.fn();
    const { e } = engine({ three: threeDeps(), ownedTimers: { cancelOwnedBy } });
    await e.load(load({ id: "t", kind: "three", source: "return () => {};", three: { cameraPreset: "ground", pixelRatio: 1 } }));
    // The factory re-runs with fresh closure state: whatever the old instance
    // started is nobody's now, and would run twice beside the new one's.
    await e.load(load({ id: "t", kind: "three", source: "return () => {};", three: { cameraPreset: "billboard", pixelRatio: 1 } }));
    expect(cancelOwnedBy).toHaveBeenCalledWith("t");
  });

  it("M3 — a same-hash recompile of a 2D body still keeps its timers (NEW-3 unchanged)", async () => {
    const cancelOwnedBy = vi.fn();
    const { e } = engine({ ownedTimers: { cancelOwnedBy } });
    await e.load(load());
    await e.load(load({ kind: "tracked" }));
    expect(cancelOwnedBy).not.toHaveBeenCalled();
  });
});

describe("LayerEngine — Task 14 review m2: the rest of the entries map is read through captured primitives", () => {
  const mapProto = Map.prototype as unknown as Record<string, unknown>;
  const iterProto = Object.getPrototypeOf(new Map().values()) as Record<string, unknown>;

  /** Patch `obj[name]` for the duration of `fn`, as a body in the shared realm could. */
  function patched<T>(obj: Record<string, unknown>, name: string, value: unknown, fn: () => T): T {
    const original = obj[name];
    obj[name] = value;
    try {
      return fn();
    } finally {
      obj[name] = original;
    }
  }

  it("evictIdle still releases an idle layer when Map.prototype.values hides every entry", async () => {
    const { e, canvases } = engine();
    await e.load(load());
    e.render(render());
    now += IDLE_LAYER_MS + 1;
    const evicted = patched(mapProto, "values", function values() { return new Map().values(); }, () => e.evictIdle());
    expect(evicted).toBe(1);
    expect([canvases[0].width, canvases[0].height]).toEqual([1, 1]);
  });

  it("evictIdle still releases an idle layer when the Map iterator's next says done", async () => {
    const { e, canvases } = engine();
    await e.load(load());
    e.render(render());
    now += IDLE_LAYER_MS + 1;
    const evicted = patched(iterProto, "next", function next() { return { done: true, value: undefined }; }, () => e.evictIdle());
    expect(evicted).toBe(1);
    expect([canvases[0].width, canvases[0].height]).toEqual([1, 1]);
  });

  it("isLoaded answers from the real map when Map.prototype.has is patched", async () => {
    const { e } = engine();
    await e.load(load());
    expect(patched(mapProto, "has", function has() { return false; }, () => e.isLoaded("o1"))).toBe(true);
    expect(patched(mapProto, "has", function has() { return true; }, () => e.isLoaded("ghost"))).toBe(false);
  });
});
