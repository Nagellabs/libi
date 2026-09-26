import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { sectionKeyForHeading } from "@/mcp/manual-sections";
import { LOAD_TIMEOUT_MS, PROBE_EXTRA_BUDGET_MS } from "@/lib/sandbox/host";
import {
  contentFitOps,
  measureCodeContentBox,
  probeFrames,
  PROBE_SAMPLE_COUNT,
  PROBE_BUDGET_MS,
  PROBE_MIN_SAMPLES,
  FIT_SUBDIVISION_DEPTH,
  fitPathSizes,
  interpolateContentBox,
  segmentContentBox,
  type ContentBox,
  type ProbeTimeline,
} from "@/lib/overlays/code-content-fit";

// Inject a real (@napi-rs) canvas so the probe can actually rasterize + read
// back pixels in the node test environment (jsdom/node has no real canvas).
const makeCanvas = (w: number, h: number) =>
  createCanvas(w, h) as unknown as OffscreenCanvas;

type Ctx = {
  ctx: CanvasRenderingContext2D;
  progress?: number;
  time: number;
  frame: number;
  fps: number;
  totalFrames: number;
  duration?: number;
};

/** A 3 s overlay at 30 fps — what the renderer hands a body on that timeline. */
const T3: ProbeTimeline = { fps: 30, totalFrames: 90, duration: 3 };

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
    const box = measureCodeContentBox(fn as never, 200, 100, T3, { makeCanvas });
    expect(box).toEqual({ x: 10, y: 20, width: 40, height: 40 });
  });

  it("returns null when the fn draws nothing at any sample (degenerate)", () => {
    const fn = () => {
      /* draws nothing */
    };
    expect(measureCodeContentBox(fn as never, 200, 100, T3, { makeCanvas })).toBeNull();
  });

  it("returns null (identity fallback) when the fn throws", () => {
    const fn = () => {
      throw new Error("boom");
    };
    expect(measureCodeContentBox(fn as never, 200, 100, T3, { makeCanvas })).toBeNull();
  });

  it("captures content that only draws on the overlay's LAST frame", () => {
    const fn = (c: Ctx) => {
      if (c.frame === c.totalFrames - 1) {
        c.ctx.fillStyle = "#ffffff";
        c.ctx.fillRect(5, 5, 10, 10);
      }
    };
    const box = measureCodeContentBox(fn as never, 200, 100, T3, { makeCanvas });
    expect(box).toEqual({ x: 5, y: 5, width: 10, height: 10 });
  });

  it("never samples progress 1: the overlay window is half-open, so ink drawn only there is never painted", () => {
    const fn = (c: Ctx) => {
      c.ctx.fillStyle = "#ffffff";
      c.ctx.fillRect(20, 20, 10, 10);
      if ((c.progress ?? 0) >= 1) c.ctx.fillRect(150, 80, 10, 10);
    };
    expect(measureCodeContentBox(fn as never, 200, 100, T3, { makeCanvas })).toEqual({ x: 20, y: 20, width: 10, height: 10 });
  });

  it("unions the ink bbox across animated samples (moving content stays inside)", () => {
    // A dot that moves left→right AND clears every frame — only the union of all
    // sample positions gives a box wide enough to contain the whole animation.
    const fn = (c: Ctx) => {
      c.ctx.clearRect(0, 0, 200, 100);
      c.ctx.fillStyle = "#ffffff";
      const p = c.progress ?? 0;
      const x = Math.round(p * 100); // first frame at 0, last frame at ~99
      c.ctx.fillRect(x, 40, 10, 10);
    };
    const box = measureCodeContentBox(fn as never, 200, 100, T3, { makeCanvas });
    // union spans the first dot at 0 to the last frame's dot at round(89/90·100)=99
    expect(box).not.toBeNull();
    expect(box!.x).toBe(0);
    expect(box!.width).toBe(109);
    expect(box!.y).toBe(40);
    expect(box!.height).toBe(10);
  });

  it("returns null without a real canvas (no OffscreenCanvas, no factory)", () => {
    const fn = (c: Ctx) => c.ctx.fillRect(0, 0, 10, 10);
    // No makeCanvas + node has no OffscreenCanvas → cannot probe → null.
    expect(measureCodeContentBox(fn as never, 200, 100, T3)).toBeNull();
  });
});

// Bug 1 of the 2026-09-25 explainer session: the probe measured a fabricated
// 1 s timeline, so an overlay whose content arrives after the first second
// was fitted to a fraction of it — zoomed ~1.3x and clipped at the rect edge.
describe("measureCodeContentBox — the overlay's real timeline", () => {
  const T10: ProbeTimeline = { fps: 30, totalFrames: 300, duration: 10 };

  /** A title from t=0, and a wider row that only enters at t >= 2 s. */
  const lateRow = (c: Ctx) => {
    c.ctx.fillStyle = "#ffffff";
    c.ctx.fillRect(20, 20, 100, 20);
    if (c.time >= 2) c.ctx.fillRect(20, 60, 160, 30);
  };

  it("fits content that appears only after 2 s by its full extent — not zoomed", () => {
    const box = measureCodeContentBox(lateRow as never, 200, 100, T10, { makeCanvas });
    expect(box).toEqual({ x: 20, y: 20, width: 160, height: 70 });
    // The fit of the full extent: scale min(200/160, 100/70) = 1.25, NOT the
    // 1.43x zoom the title alone (100 × 20) would get — which pushed the late
    // row past the rect's right edge.
    const fit = contentFitOps(box!, 200, 100);
    expect(fit.scale).toBeCloseTo(1.25, 5);
    expect(20 * fit.scale + fit.dx + 160 * fit.scale).toBeLessThanOrEqual(200 + 1e-9);
  });

  it("hands the body the real fps / totalFrames / duration, and element-local frame / time / progress", () => {
    // 5.85 s at 30 fps: totalFrames = round(175.5) = 176, so time/duration and
    // frame/totalFrames differ — progress must be the former, as elementTiming has it.
    const T = { fps: 30, totalFrames: 176, duration: 5.85 };
    const seen: Ctx[] = [];
    measureCodeContentBox(((c: Ctx) => void seen.push({ ...c })) as never, 200, 100, T, { makeCanvas });
    for (const c of seen) {
      expect(c.fps).toBe(30);
      expect(c.totalFrames).toBe(176);
      expect(c.duration).toBe(5.85);
      expect(c.time).toBeCloseTo(c.frame / 30, 9);
      expect(c.progress).toBeCloseTo(c.time / 5.85, 9);
    }
    // Coarse to fine: the first frame, then the last one drawn.
    expect(seen[0].frame).toBe(0);
    expect(seen[1].frame).toBe(175);
  });

  it("a static body measures the same box on any timeline (its fit is unchanged)", () => {
    const still = (c: Ctx) => {
      c.ctx.fillStyle = "#ffffff";
      c.ctx.fillRect(30, 10, 120, 60);
    };
    const expected = { x: 30, y: 10, width: 120, height: 60 };
    for (const t of [T3, T10, { fps: 24, totalFrames: 1, duration: 0.04 }, { fps: 60, totalFrames: 3600, duration: 60 }]) {
      expect(measureCodeContentBox(still as never, 200, 100, t, { makeCanvas })).toEqual(expected);
    }
  });

  it("cost is bounded: at most PROBE_SAMPLE_COUNT body calls however long the overlay, first and last frame included", () => {
    for (const totalFrames of [1, 2, 7, 16, 90, 3600, 108_000]) {
      const frames: number[] = [];
      const fn = (c: Ctx) => {
        frames.push(c.frame);
        c.ctx.fillRect(c.frame % 50, 10, 1, 1); // never edge to edge: no early exit
      };
      measureCodeContentBox(fn as never, 200, 100, { fps: 30, totalFrames, duration: totalFrames / 30 }, { makeCanvas });
      expect(frames.length).toBe(Math.min(PROBE_SAMPLE_COUNT, totalFrames));
      expect(frames[0]).toBe(0);
      expect(Math.max(...frames)).toBe(totalFrames - 1);
      expect(frames).toEqual(probeFrames(totalFrames));
    }
  });

  it("stops sampling once the ink reaches every edge — nothing later can widen the box", () => {
    let calls = 0;
    const fullRect = (c: Ctx) => {
      calls++;
      c.ctx.fillStyle = "rgba(0,0,0,0.02)";
      c.ctx.fillRect(0, 0, 200, 100);
    };
    expect(measureCodeContentBox(fullRect as never, 200, 100, T10, { makeCanvas })).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    expect(calls).toBe(1);
  });

  it("the box only grows over the timeline: an element that leaves still counts, so the one fit never jumps", () => {
    // Enters at 1 s, leaves at 3 s; another element later on the other side.
    const fn = (c: Ctx) => {
      c.ctx.fillStyle = "#ffffff";
      if (c.time >= 1 && c.time < 3) c.ctx.fillRect(10, 10, 20, 20);
      if (c.time >= 6) c.ctx.fillRect(150, 60, 30, 30);
    };
    expect(measureCodeContentBox(fn as never, 200, 100, T10, { makeCanvas })).toEqual({ x: 10, y: 10, width: 170, height: 80 });
  });

  it("probeFrames runs coarse to fine: first, last, middle, quarters, eighths, sixteenths — an even grid, no duplicates", () => {
    expect(probeFrames(1)).toEqual([0]);
    expect(probeFrames(0)).toEqual([0]);
    expect(probeFrames(3)).toEqual([0, 2, 1]);
    const f = probeFrames(321); // last = 320: the 1/16 grid is every 20 frames
    expect(f).toHaveLength(PROBE_SAMPLE_COUNT);
    expect(f.slice(0, 9)).toEqual([0, 320, 160, 80, 240, 40, 120, 200, 280]);
    expect([...f].sort((a, b) => a - b)).toEqual(Array.from({ length: 17 }, (_, i) => i * 20));
    // Every prefix of 2^k + 1 samples is itself an even grid over the whole timeline.
    for (const k of [1, 2, 3]) {
      const prefix = f.slice(0, 2 ** k + 1).sort((a, b) => a - b);
      const step = 320 / 2 ** k;
      expect(prefix).toEqual(Array.from({ length: 2 ** k + 1 }, (_, i) => i * step));
    }
    const g = probeFrames(300);
    expect(new Set(g).size).toBe(g.length);
    expect(Math.max(...g)).toBe(299);
  });
});

// Review I1 (2026-09-25): the probe runs inside a body's first render, which
// the watchdog times at 5 s. Sampling 17 frames of a slow body would drop a
// body that rendered fine before, so the probe keeps its own time budget.
describe("measureCodeContentBox — its own time budget", () => {
  const T10: ProbeTimeline = { fps: 30, totalFrames: 300, duration: 10 };
  /** A clock the body advances: each call costs `ms`, the first `firstMs`. */
  function timedBody(ms: number, draw: (c: Ctx) => void, firstMs = ms) {
    const clock = { t: 0 };
    const frames: number[] = [];
    const fn = (c: Ctx) => {
      clock.t += frames.length === 0 ? firstMs : ms;
      frames.push(c.frame);
      draw(c);
    };
    return { fn, frames, now: () => clock.t };
  }
  /** A dot at the left on the first frame, at the right on the last, a bar in the middle otherwise. */
  const endsApart = (c: Ctx) => {
    c.ctx.fillStyle = "#ffffff";
    if (c.frame === 0) c.ctx.fillRect(10, 40, 10, 10);
    else if (c.frame === c.totalFrames - 1) c.ctx.fillRect(170, 40, 10, 10);
    else c.ctx.fillRect(90, 40, 20, 10);
  };
  /** Draws only between 4.5 s and 5.5 s — the mid-timeline element of bug 1. */
  const midOnly = (c: Ctx) => {
    c.ctx.fillStyle = "#ffffff";
    c.ctx.fillRect(20, 20, 20, 20);
    if (c.time >= 4.5 && c.time < 5.5) c.ctx.fillRect(100, 60, 80, 30);
  };

  for (const ms of [200, 300, 500, 800]) {
    it(`a ${ms} ms/frame body: always the five coarse frames, never a dearer first render than the old probe allowed`, () => {
      const { fn, frames, now } = timedBody(ms, endsApart);
      const stops: unknown[] = [];
      const box = measureCodeContentBox(fn as never, 200, 100, T10, { makeCanvas, now, onBudgetStop: (s) => stops.push(s) });
      expect(frames.length).toBeGreaterThanOrEqual(PROBE_MIN_SAMPLES);
      expect(frames.slice(0, 5)).toEqual([0, 299, 150, 75, 224]);
      const spent = frames.length * ms;
      // The first call + max(4 calls, the budget).
      expect(spent).toBeLessThanOrEqual(ms + Math.max(4 * ms, PROBE_BUDGET_MS));
      // With the paint: six calls (the old probe's cost) for a body slow
      // enough to matter, so every body that rendered before still renders.
      if (ms >= PROBE_BUDGET_MS / 4) expect(spent + ms).toBe(6 * ms);
      expect(box).toEqual({ x: 10, y: 40, width: 170, height: 10 });
      expect(stops).toHaveLength(1);
      expect(stops[0]).toMatchObject({ sampled: frames.length, planned: PROBE_SAMPLE_COUNT, budgetMs: PROBE_BUDGET_MS });
    });
  }

  it("a fast body samples every planned frame and reports no stop", () => {
    const { fn, frames, now } = timedBody(5, endsApart);
    const onBudgetStop = vi.fn();
    measureCodeContentBox(fn as never, 200, 100, T10, { makeCanvas, now, onBudgetStop });
    expect(frames).toHaveLength(PROBE_SAMPLE_COUNT);
    expect(onBudgetStop).not.toHaveBeenCalled();
  });

  it("the worker's warm-up on the FIRST sample does not cut a fast body's probe: same frames, same box, warm or cold (review I2)", () => {
    const warm = timedBody(5, midOnly);
    const warmBox = measureCodeContentBox(warm.fn as never, 200, 100, T10, { makeCanvas, now: warm.now });
    for (const warmUp of [1600, 5000]) {
      const cold = timedBody(5, midOnly, warmUp);
      const onBudgetStop = vi.fn();
      const coldBox = measureCodeContentBox(cold.fn as never, 200, 100, T10, { makeCanvas, now: cold.now, onBudgetStop });
      expect(cold.frames).toEqual(warm.frames);
      expect(cold.frames).toHaveLength(PROBE_SAMPLE_COUNT);
      expect(onBudgetStop).not.toHaveBeenCalled();
      // The preview (warm worker) and an export chunk (cold worker) fit alike…
      expect(coldBox).toEqual(warmBox);
    }
    // …and the mid-timeline element is in it.
    expect(warmBox).toEqual({ x: 20, y: 20, width: 160, height: 70 });
  });

  it("a genuinely slow body still sees the coarse timeline: an element in its middle second is measured", () => {
    const slow = timedBody(400, midOnly);
    const box = measureCodeContentBox(slow.fn as never, 200, 100, T10, { makeCanvas, now: slow.now });
    expect(slow.frames.length).toBeLessThan(PROBE_SAMPLE_COUNT);
    expect(box).toEqual({ x: 20, y: 20, width: 160, height: 70 });
  });

  it("a stopped probe's box is a subset of the full one: everything it measured still fits the rect", () => {
    const moving = (c: Ctx) => {
      c.ctx.fillStyle = "#ffffff";
      c.ctx.fillRect(Math.round((c.frame / 299) * 180), 40, 10, 10);
    };
    const full = measureCodeContentBox(moving as never, 200, 100, T10, { makeCanvas })!;
    const slow = timedBody(400, moving);
    const partial = measureCodeContentBox(slow.fn as never, 200, 100, T10, { makeCanvas, now: slow.now })!;
    expect(partial.x).toBeGreaterThanOrEqual(full.x);
    expect(partial.x + partial.width).toBeLessThanOrEqual(full.x + full.width);
    expect(contentFitOps(partial, 200, 100).scale).toBeGreaterThanOrEqual(contentFitOps(full, 200, 100).scale);
  });
});

// Review I3 (2026-09-25): a keyframed rect SIZE changes every frame of a tween.
// The box is measured at the segment's two ends and interpolated between them.
describe("interpolateContentBox — a keyframed size between its two measured ends", () => {
  const at400 = { width: 400, height: 100 };
  const at800 = { width: 800, height: 100 };
  /** Fixed-pixel content: a 300 × 60 block centred in whatever rect it gets. */
  const fixedPx = (c: Ctx & { width: number; height: number }) => {
    c.ctx.fillStyle = "#ffffff";
    c.ctx.fillRect(Math.round((c.width - 300) / 2), 20, 300, 60);
  };
  const T3only: ProbeTimeline = { fps: 30, totalFrames: 90, duration: 3 };
  const measureAt = (fn: unknown, size: { width: number; height: number }) =>
    measureCodeContentBox(fn as never, size.width, size.height, T3only, { makeCanvas });

  it("matches the exact box at every size, to the pixel it is rounded out by, for content affine in the size — fixed-pixel and proportional", () => {
    const proportional = (c: Ctx & { width: number; height: number }) => {
      c.ctx.fillStyle = "#ffffff";
      c.ctx.fillRect(c.width * 0.25, 10, c.width * 0.5, 50);
    };
    for (const fn of [fixedPx, proportional]) {
      const from = { box: measureAt(fn, at400), size: at400 };
      const to = { box: measureAt(fn, at800), size: at800 };
      for (let w = 400; w <= 800; w += 7) {
        const got = interpolateContentBox(from, to, { width: w, height: 100 })!;
        const exact = measureAt(fn, { width: w, height: 100 })!;
        // Contains the exact box, and is at most a pixel larger on each side.
        expect(got.x).toBeLessThanOrEqual(exact.x);
        expect(got.x + got.width).toBeGreaterThanOrEqual(exact.x + exact.width);
        expect(exact.x - got.x).toBeLessThanOrEqual(1);
        expect(got.x + got.width - (exact.x + exact.width)).toBeLessThanOrEqual(1);
        expect(got.y).toBe(exact.y);
        expect(got.height).toBe(exact.height);
      }
    }
  });

  it("fixed-pixel content under a 400 → 800 px tween: the scale follows the tween with no steps, and its ink never leaves the rect", () => {
    // The body snaps its block to whole pixels — the case that inks past the
    // ideal affine edge, and the one the rounding-out exists for.
    const from = { box: measureAt(fixedPx, at400), size: at400 };
    const to = { box: measureAt(fixedPx, at800), size: at800 };
    let prev = 0;
    for (let w = 400; w <= 800; w++) {
      const box = interpolateContentBox(from, to, { width: w, height: 100 })!;
      const f = contentFitOps(box, w, 100);
      // Monotone to within the one-pixel quantum of a 300 px block (1/300),
      // and never a step: the old per-bucket measure jumped ~9 % at once.
      if (prev) {
        expect(f.scale).toBeGreaterThan(prev * (1 - 1 / 300) - 1e-12);
        expect(Math.abs(f.scale - prev) / prev).toBeLessThan(0.01);
      }
      prev = f.scale;
      // The block as the body draws it at this size lands inside the rect.
      const left = f.dx + Math.round((w - 300) / 2) * f.scale;
      const right = left + 300 * f.scale;
      expect(left).toBeGreaterThanOrEqual(-1e-6);
      expect(right).toBeLessThanOrEqual(w + 1e-6);
    }
  });

  it("at either end — and so for the hold after the tween — the box IS the exact measurement there", () => {
    const from = { box: measureAt(fixedPx, at400), size: at400 };
    const to = { box: measureAt(fixedPx, at800), size: at800 };
    expect(interpolateContentBox(from, to, at400)).toBe(from.box);
    expect(interpolateContentBox(from, to, at800)).toBe(to.box);
  });

  it("a box that fills its rect at both ends fills it exactly in between — the identity fit, never 1 ulp off (M10)", () => {
    const full = (s: { width: number; height: number }) => ({ box: { x: 0, y: 0, width: s.width, height: s.height }, size: s });
    const got = interpolateContentBox(full(at400), full(at800), { width: 613, height: 100 })!;
    expect(got).toEqual({ x: 0, y: 0, width: 613, height: 100 });
    expect(contentFitOps(got, 613, 100)).toEqual({ scale: 1, dx: 0, dy: 0 });
  });

  it("takes u on the axis that changes more, and passes a missing end straight through", () => {
    const a = { box: { x: 0, y: 0, width: 10, height: 10 }, size: { width: 100, height: 100 } };
    const b = { box: { x: 0, y: 0, width: 30, height: 10 }, size: { width: 104, height: 300 } };
    expect(interpolateContentBox(a, b, { width: 102, height: 200 })!.width).toBeCloseTo(20, 9);
    expect(interpolateContentBox({ box: null, size: a.size }, b, a.size)).toBe(b.box);
  });
});

// M11 (re-review 2): a layout that bends mid-tween is measured at the midpoint
// and halved towards the frame's size; the worker measures a PREFIX of the
// path the host budgets for.
describe("segmentContentBox / fitPathSizes — halving a segment that bends", () => {
  const W = (width: number) => ({ width, height: 600 });
  it("measures a prefix of fitPathSizes, in its order, for any body and any size", () => {
    const ring = (s: { width: number; height: number }) => {
      const r = Math.round(0.4 * Math.min(s.width, s.height));
      return { x: Math.round(s.width / 2) - r, y: 300 - r, width: 2 * r, height: 2 * r };
    };
    const affine = (s: { width: number; height: number }) => ({ x: 20, y: 20, width: s.width - 40, height: 100 });
    const steps = (s: { width: number; height: number }) => ({ x: 0, y: 0, width: 50, height: 30 * Math.ceil(1000 / s.width) });
    for (const body of [ring, affine, steps]) {
      for (const w of [400, 430, 555, 600, 601, 777, 800]) {
        const seen: string[] = [];
        segmentContentBox(W(400), W(800), W(w), (s) => { seen.push(`${s.width}x${s.height}`); return body(s); });
        const path = fitPathSizes(W(400), W(800), W(w)).map((s) => `${s.width}x${s.height}`);
        expect(path.slice(0, seen.length)).toEqual(seen);
        expect(path.length).toBeLessThanOrEqual(3 + FIT_SUBDIVISION_DEPTH);
      }
    }
  });
  it("the ring 400×600 → 800×600: exact at the kink, where plain interpolation was 80 px short", () => {
    const ring = (s: { width: number; height: number }) => {
      const r = Math.round(0.4 * Math.min(s.width, s.height));
      return { x: Math.round(s.width / 2) - r, y: 300 - r, width: 2 * r, height: 2 * r };
    };
    expect(interpolateContentBox({ box: ring(W(400)), size: W(400) }, { box: ring(W(800)), size: W(800) }, W(600))!.width).toBe(400);
    for (let w = 400; w <= 800; w += 10) {
      const got = segmentContentBox(W(400), W(800), W(w), ring)!;
      const exact = ring(W(w));
      expect(got.x).toBeLessThanOrEqual(exact.x);
      expect(got.x + got.width).toBeGreaterThanOrEqual(exact.x + exact.width);
      expect(got.y).toBeLessThanOrEqual(exact.y);
      expect(got.y + got.height).toBeGreaterThanOrEqual(exact.y + exact.height);
    }
  });
  it("an affine body stops after one agreeing midpoint: three sizes measured", () => {
    const seen: number[] = [];
    segmentContentBox(W(400), W(800), W(517), (s) => { seen.push(s.width); return { x: 10, y: 10, width: s.width - 20, height: 80 }; });
    expect(seen).toEqual([400, 800, 600]);
  });
});

describe("the agent manual describes this fit", () => {
  it("names the sample count, the gap a flash can fall through and the probe's own budget (drift guard)", () => {
    const manual = readFileSync(join(process.cwd(), "mcp/templates/instructions.md"), "utf8");
    expect(manual).toContain("## How a code overlay is fitted to its rect\n\nThe body's box is fitted to everything it draws.");
    expect(manual).toContain(`up to ${PROBE_SAMPLE_COUNT} frames from its first to its last`);
    expect(manual).toContain(`\`duration / ${PROBE_SAMPLE_COUNT - 1}\``);
    expect(manual).toContain(`${PROBE_BUDGET_MS / 1000} s`);
    // The first-edit essentials point at it, by a key that resolves.
    expect(manual).toContain("see manual section `how-a-code-overlay-is-fitted-to-its-rect`");
    expect(sectionKeyForHeading("How a code overlay is fitted to its rect")).toBe("how-a-code-overlay-is-fitted-to-its-rect");
    // M13: the budget line names the tween first-frame budget the host really gives.
    expect(manual).toContain(`plus ${PROBE_EXTRA_BUDGET_MS / 1000} s for each further size`);
    expect(manual).toContain(`up to ${(LOAD_TIMEOUT_MS + (2 + FIT_SUBDIVISION_DEPTH) * PROBE_EXTRA_BUDGET_MS) / 1000} s on a tween segment's first frame`);
    // M8: no promise that a stopped probe only ever fits "slightly larger".
    expect(manual).not.toContain("slightly larger");
  });
});
