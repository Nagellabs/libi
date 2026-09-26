import { clamp01 } from "@/lib/engine/overlay-timing";
import type { DrawContext } from "@/lib/engine/types";

/** The union alpha-bbox of a code overlay's drawing, in the fn's own
 *  (rect-local, origin-at-0,0) coordinate space. */
export interface ContentBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A compiled code-overlay draw function (see `createDrawFunction`). */
export type CompiledDrawFn = (ctx: DrawContext) => void;

type CanvasFactory = (w: number, h: number) => OffscreenCanvas | HTMLCanvasElement;

/**
 * The timeline the probe measures over — the overlay's OWN element-local
 * timeline, the one the body is handed when it paints (`fps`, `totalFrames`,
 * `duration`; see `elementTiming`). Never a stand-in: a body that paces off
 * real seconds (an element entering at t = 2 s, an exit keyed to `duration`)
 * only draws its whole content somewhere on its real timeline, and a probe
 * over a fabricated one fits a fraction of it — the 2026-09-25 bug, where a
 * fake 1 s timeline zoomed late-arriving graphics ~1.3x and clipped them at
 * the rect edge.
 *
 * Sample times are `frame / fps`. A start that is not frame-aligned shifts
 * the times the renderer really draws by under half a frame, which only
 * matters to ink that exists for less than a frame.
 */
export interface ProbeTimeline {
  fps: number;
  totalFrames: number;
  duration: number;
}

/**
 * How many frames the probe paints at most, whatever the overlay's length:
 * the first frame, the last one, and 15 more on an even grid between (so the
 * gap between samples is duration / 16). It bounds the probe's cost (one body
 * call + one alpha scan per sample) — a 60 s overlay costs the same as a 3 s
 * one — and the time budget below bounds it further for a slow body. Content
 * visible for less than that gap can be missed.
 */
export const PROBE_SAMPLE_COUNT = 17;

/**
 * The probe's own wall-clock budget, separate from the render watchdog's. It
 * decides only how many frames BEYOND the first `PROBE_MIN_SAMPLES` a
 * genuinely slow body gets, never whether the fit sees its coarse timeline.
 *
 * - The first `PROBE_MIN_SAMPLES` (5) frames — first, last, middle, both
 *   quarters — are always painted. With the render's own call that is six
 *   body calls, exactly what the probe cost before it measured the real
 *   timeline, so every body that rendered then still renders its first frame
 *   inside the watchdog's 5 s.
 * - The clock starts AFTER the first sample, and the per-sample estimate
 *   ignores it: the first body call on a fresh worker carries the worker's
 *   warm-up (JIT, first raster, first readback — ~1.6 s on SwiftShader), and
 *   counting it would stop a fast body at the minimum on a cold worker only,
 *   so the preview (warm) and an export (cold) — or two export chunks — would
 *   measure different boxes. Measured this way, a body under ~90 ms a call
 *   gets all `PROBE_SAMPLE_COUNT` frames whatever the machine is doing.
 * - Past the minimum a frame is painted only while the time spent since the
 *   first sample plus the dearest later sample still fits. So the probe costs
 *   at most the first call + max(4 calls, this budget).
 */
export const PROBE_BUDGET_MS = 1500;

/** Frames the probe paints whatever the budget: the first coarse level
 *  (first, last, middle, both quarters). See `PROBE_BUDGET_MS`. */
export const PROBE_MIN_SAMPLES = 5;

/**
 * The element-local frames the probe paints, COARSE TO FINE: the first frame,
 * the last one the overlay is drawn on (`totalFrames − 1` — the window is
 * half-open, so progress 1 is never painted and is not sampled), the middle,
 * then the quarters, the eighths, the sixteenths. A probe stopped by its time
 * budget has still looked across the whole timeline, just less densely.
 * At most `PROBE_SAMPLE_COUNT` frames (every frame of a shorter overlay).
 */
export function probeFrames(totalFrames: number): number[] {
  const last = Math.max(0, Math.floor(totalFrames) - 1);
  const n = Math.min(PROBE_SAMPLE_COUNT, last + 1);
  if (n <= 1) return [0];
  const frameAt = (i: number) => Math.round((i * last) / (n - 1));
  // Breadth-first over the index interval [0, n-1]: each level halves every
  // gap the previous levels left.
  const order = [0, n - 1];
  let level: Array<[number, number]> = [[0, n - 1]];
  while (level.length > 0) {
    const next: Array<[number, number]> = [];
    for (const [lo, hi] of level) {
      if (hi - lo < 2) continue;
      const mid = Math.floor((lo + hi) / 2);
      order.push(mid);
      next.push([lo, mid], [mid, hi]);
    }
    level = next;
  }
  const out: number[] = [];
  const seen = new Set<number>();
  for (const i of order) {
    const f = frameAt(i);
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

/**
 * The box to fit a keyframed-size rect with, between two measured sizes.
 *
 * A code overlay whose rect SIZE is keyframed changes size on every frame of
 * the tween; measuring at each size would re-run the probe every frame. The
 * host instead sends the current keyframe segment's two sizes (`fitSegment`),
 * the worker measures the box at each once, and every frame of the segment
 * interpolates between those two boxes, in absolute pixels, by where the
 * current size lies between them (`u`, taken on the axis that changes more —
 * the renderer eases both axes with one factor, so `u` IS that factor).
 *
 * Why the keyframes' own sizes and not size buckets: a box that is an affine
 * function of the rect size — fixed-pixel content (constant), proportional
 * content (linear), and the usual mix of a fixed margin plus a proportional
 * part — is reproduced EXACTLY by linear interpolation between any two sizes,
 * so the fit follows the tween continuously — to within the one pixel the
 * interpolated box is rounded out by — and ink never overflows. At a
 * keyframe, and for the hold after the tween, the size IS a measured one, so
 * the fit is the exact static fit. Buckets would add probes, make the hold
 * approximate, and need two extra measurements to be continuous. Content that
 * is not affine in the size (text that re-wraps mid-tween) is approximated
 * between the two ends, and exact at them.
 */
export function interpolateContentBox(
  from: { box: ContentBox | null; size: { width: number; height: number } },
  to: { box: ContentBox | null; size: { width: number; height: number } },
  size: { width: number; height: number },
): ContentBox | null {
  const a = from.box;
  const b = to.box;
  if (!a || !b) return a ?? b;
  // A box that fills its rect at both ends fills it at every size between —
  // snapped, so float noise can never turn the identity fit into a 1-ulp scale.
  if (fillsRect(a, from.size) && fillsRect(b, to.size)) return { x: 0, y: 0, width: size.width, height: size.height };
  const u = segmentU(from.size, to.size, size);
  if (u === 0) return a;
  if (u === 1) return b;
  const lerp = (p: number, q: number) => (1 - u) * p + u * q;
  // Rounded OUT to whole pixels, like every measured box: a body that snaps
  // its drawing to pixels (or anti-aliases a fractional edge) inks up to a
  // pixel past the ideal affine edge, and the fit must contain that ink.
  // (The epsilon keeps an edge that is already whole from growing a pixel.)
  const left = Math.floor(lerp(a.x, b.x) + 1e-7);
  const top = Math.floor(lerp(a.y, b.y) + 1e-7);
  const right = Math.ceil(lerp(a.x + a.width, b.x + b.width) - 1e-7);
  const bottom = Math.ceil(lerp(a.y + a.height, b.y + b.height) - 1e-7);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

type Size = { width: number; height: number };

/** Where `size` lies between `from` (0) and `to` (1), on the axis that
 *  changes more — the renderer eases both axes with one factor, so on a
 *  keyframe segment this IS that factor. */
function segmentU(from: Size, to: Size, size: Size): number {
  const dw = to.width - from.width;
  const dh = to.height - from.height;
  if (Math.abs(dw) >= Math.abs(dh)) return dw === 0 ? 0 : (size.width - from.width) / dw;
  return (size.height - from.height) / dh;
}

/**
 * How many times a size segment may be halved around the current size when
 * its measured midpoint disagrees with the interpolation (M11, re-review 2).
 * Interpolating between the two ends is exact only for content AFFINE in the
 * rect size; a layout on `Math.min(width, height)` (a centred ring, a badge)
 * or text wrapped to `width` bends mid-tween, and plain interpolation would
 * under-measure it there and clip it (a ring tweened 400×600 → 800×600: 20 %
 * cut off at the midpoint). The midpoint is therefore always measured; when
 * it is off by more than a pixel, the half the current size lies in is
 * measured the same way, down to this depth; a half that still bends there
 * is measured at each frame's exact size. So one frame measures at most
 * 3 + depth sizes (`fitPathSizes`), and an affine body's segment 3 in all.
 */
export const FIT_SUBDIVISION_DEPTH = 3;

function midSize(a: Size, b: Size): Size {
  return { width: Math.round((a.width + b.width) / 2), height: Math.round((a.height + b.height) / 2) };
}

function sameSize(a: Size, b: Size): boolean {
  return a.width === b.width && a.height === b.height;
}

/** The sub-segment of [from, to] the size lies in after one halving. */
function halfFor(from: Size, to: Size, mid: Size, size: Size): [Size, Size] {
  return segmentU(from, to, size) <= segmentU(from, to, mid) ? [from, mid] : [mid, to];
}

/**
 * Every size a frame at `size` inside the segment may need measured, in the
 * order they are measured: the two ends, then the midpoint of each halving
 * towards `size`. The worker measures a PREFIX of this (it stops halving once
 * a midpoint agrees); the host budgets for all of it (`contentFitKeys`).
 */
export function fitPathSizes(from: Size, to: Size, size: Size): Size[] {
  const out: Size[] = [from, to];
  let [a, b] = [from, to];
  let level = 0;
  for (; level < FIT_SUBDIVISION_DEPTH; level++) {
    const mid = midSize(a, b);
    if (sameSize(mid, a) || sameSize(mid, b)) return out;
    out.push(mid);
    [a, b] = halfFor(a, b, mid, size);
  }
  // Still bending at full depth: the exact size itself.
  if (!sameSize(size, a) && !sameSize(size, b)) out.push(size);
  return out;
}

/** Within a pixel on every edge — the rounding a measured box carries. */
function boxesAgree(m: ContentBox | null, i: ContentBox | null): boolean {
  if (!m || !i) return m === i;
  return (
    Math.abs(m.x - i.x) <= 1 &&
    Math.abs(m.y - i.y) <= 1 &&
    Math.abs(m.x + m.width - (i.x + i.width)) <= 1 &&
    Math.abs(m.y + m.height - (i.y + i.height)) <= 1
  );
}

/**
 * The box for a frame at `size` inside a keyframed-size segment: the two ends
 * measured (`boxAt`), their midpoint measured and checked against the
 * interpolation, and — while it disagrees — the half holding `size` halved
 * again, to `FIT_SUBDIVISION_DEPTH`. The result is the interpolation between
 * the two measured sizes that bracket `size` most tightly. Deterministic: the
 * sizes measured depend only on the segment, `size` and the body's boxes.
 */
export function segmentContentBox(from: Size, to: Size, size: Size, boxAt: (s: Size) => ContentBox | null): ContentBox | null {
  let a = { size: from, box: boxAt(from) };
  let b = { size: to, box: boxAt(to) };
  for (let level = 0; level < FIT_SUBDIVISION_DEPTH; level++) {
    const midAt = midSize(a.size, b.size);
    if (sameSize(midAt, a.size) || sameSize(midAt, b.size)) return interpolateContentBox(a, b, size);
    const mid = { size: midAt, box: boxAt(midAt) };
    if (boxesAgree(mid.box, interpolateContentBox(a, b, midAt))) return interpolateContentBox(a, b, size);
    if (segmentU(a.size, b.size, size) <= segmentU(a.size, b.size, midAt)) b = mid;
    else a = mid;
  }
  // Still bending at full depth (text re-wrapping in steps, say): inside this
  // last eighth of the segment, measure the frame's own size — exact, as
  // every frame was before the tween path existed, and never clipped.
  if (sameSize(size, a.size)) return a.box;
  if (sameSize(size, b.size)) return b.box;
  return boxAt(size);
}

function fillsRect(box: ContentBox, size: { width: number; height: number }): boolean {
  return box.x === 0 && box.y === 0 && box.width === Math.max(1, Math.floor(size.width)) && box.height === Math.max(1, Math.floor(size.height));
}

/** Why a probe stopped before painting every planned frame to its time budget. */
export interface ProbeBudgetStop {
  sampled: number;
  planned: number;
  elapsedMs: number;
  budgetMs: number;
}

export interface MeasureOptions {
  /** Injected canvas factory — required in environments without
   *  `OffscreenCanvas` (jsdom/node tests). Defaults to `OffscreenCanvas` / a
   *  DOM `<canvas>` in the browser. */
  makeCanvas?: CanvasFactory;
  /** The clock the budget is kept by (ms). Without one the probe has no time
   *  budget, only the sample count. */
  now?: () => number;
  /** Defaults to `PROBE_BUDGET_MS`. */
  budgetMs?: number;
  /** Called once when the budget stopped the probe early. The box returned is
   *  the union of the frames it did paint (at least the five coarse ones): a
   *  subset of the full union. Everything measured still fits the rect; an
   *  element visible only between the frames painted is missed, and clipped
   *  if it reaches past the measured box. */
  onBudgetStop?(stop: ProbeBudgetStop): void;
}

function defaultCanvasFactory(): CanvasFactory | null {
  if (typeof OffscreenCanvas !== "undefined") {
    return (w, h) => new OffscreenCanvas(w, h);
  }
  if (typeof document !== "undefined") {
    return (w, h) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      return c;
    };
  }
  return null;
}

/**
 * Contain-fit ops mapping a measured content box into the overlay rect: the
 * content scales UP when smaller than the rect and DOWN when larger, and the
 * result is centered. `scale = min(rectW/box.width, rectH/box.height)`.
 *
 * Applied by the renderer as `ctx.translate(dx, dy); ctx.scale(scale, scale)`
 * AFTER the rect clip + origin translate, so a point `p` in the fn's coordinate
 * space lands at `dx + p*scale`. A box equal to the rect ⇒ `{scale:1,dx:0,dy:0}`
 * (identity, byte-identical to the pre-fit render). A degenerate zero-size box
 * ⇒ identity too (the renderer never applies a zero blit).
 */
export function contentFitOps(
  box: ContentBox,
  rectW: number,
  rectH: number,
): { scale: number; dx: number; dy: number } {
  if (box.width <= 0 || box.height <= 0) return { scale: 1, dx: 0, dy: 0 };
  const scale = Math.min(rectW / box.width, rectH / box.height);
  const dx = (rectW - box.width * scale) / 2 - box.x * scale;
  const dy = (rectH - box.height * scale) / 2 - box.y * scale;
  return { scale, dx, dy };
}

/**
 * Probe a compiled code-overlay draw fn ONCE (off the hot render path) to find
 * the union alpha-bbox of everything it draws at the given rect size over its
 * WHOLE timeline (`probeFrames`, coarse to fine, within `PROBE_BUDGET_MS`).
 * Returns `null` when the fn draws nothing at every sample, throws at every
 * sample, or no real canvas is available (no `OffscreenCanvas` and no injected
 * factory) — in all those cases the renderer falls back to identity (no
 * scale), never a crash or a zero-size blit.
 *
 * One box for the whole timeline, deliberately: the fit it produces is applied
 * unchanged to every frame, so the box only ever GROWS while it is measured
 * and never changes between frames. A per-frame fit would rescale the content
 * as elements enter and leave — everything already on screen would jump.
 *
 * The fn is invoked with the timing shape the renderer passes a code body
 * (rect-space `width`/`height`, element-local `frame`/`time`/`progress` on the
 * overlay's real `fps`/`totalFrames`/`duration` — `elementTiming`), so the
 * measured box matches what the renderer will actually paint.
 */
export function measureCodeContentBox(
  fn: CompiledDrawFn,
  rectW: number,
  rectH: number,
  timeline: ProbeTimeline,
  opts: MeasureOptions = {},
): ContentBox | null {
  const factory = opts.makeCanvas ?? defaultCanvasFactory();
  if (!factory) return null;

  const w = Math.max(1, Math.floor(rectW));
  const h = Math.max(1, Math.floor(rectH));
  if (rectW <= 0 || rectH <= 0) return null;

  const canvas = factory(w, h);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) return null;

  const { fps, totalFrames, duration } = timeline;
  const frames = probeFrames(totalFrames);
  const now = opts.now;
  const budgetMs = opts.budgetMs ?? PROBE_BUDGET_MS;
  /** When the budget's clock started: after the first sample (see
   *  `PROBE_BUDGET_MS`). */
  let clockFrom = 0;
  /** The dearest sample after the first (body call + readback + scan): the
   *  next one is assumed to cost as much. */
  let dearest = 0;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < frames.length; i++) {
    const sampleStart = now ? now() : 0;
    if (now && i >= PROBE_MIN_SAMPLES && sampleStart - clockFrom + dearest > budgetMs) {
      opts.onBudgetStop?.({ sampled: i, planned: frames.length, elapsedMs: sampleStart - clockFrom, budgetMs });
      break;
    }
    const frame = frames[i]!;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    const time = fps > 0 ? frame / fps : 0;
    const progress = duration > 0 ? clamp01(time / duration) : 0;
    let drew = true;
    try {
      fn({
        ctx,
        width: rectW,
        height: rectH,
        fps,
        totalFrames,
        frame,
        time,
        duration,
        progress,
        assets: {},
        renderScale: 1,
      });
    } catch {
      // A throwing sample contributes nothing — continue so a fn that only
      // fails at one point of its timeline can still measure from the others.
      drew = false;
    }
    ctx.restore();

    if (drew) {
      let data: Uint8ClampedArray;
      try {
        data = ctx.getImageData(0, 0, w, h).data;
      } catch {
        return null;
      }
      // Scan the alpha channel (every 4th byte) for the ink extent of THIS
      // sample. Pixels inside the union found so far cannot extend it, so rows
      // it spans are scanned only to its left and right.
      for (let y = 0; y < h; y++) {
        const rowBase = y * w * 4;
        const inside = y >= minY && y <= maxY;
        for (let x = 0; x < w; x++) {
          if (inside && x >= minX && x <= maxX) {
            x = maxX;
            continue;
          }
          if (data[rowBase + x * 4 + 3] !== 0) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
    }
    if (now) {
      const end = now();
      if (i === 0) clockFrom = end;
      else dearest = Math.max(dearest, end - sampleStart);
    }
    // Ink edge to edge: no later sample can widen the box.
    if (minX === 0 && minY === 0 && maxX === w - 1 && maxY === h - 1) break;
  }

  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
