import type { Track, TrackSample } from "@/lib/tracking/types";
import { POSITION_RESET_GAP_SEC } from "@/lib/tracking/position-stabilize";

/** Centered sliding-median window (frames) for temporal w/h smoothing.
 *  Odd. 7 ≈ 233ms at 30fps — long enough to reject the detector's fast
 *  head↔head+neck size flap (the residual-bounce root cause), short enough
 *  that a centered median of a real monotone size trend (subject approaching
 *  the camera) is the identity — zero lag on genuine slow changes. */
export const SIZE_MEDIAN_WINDOW = 7;

export interface SizeStabilizeOpts {
  mode: "stabilized" | "raw";
  /** Max factor a frame box may exceed the track median before clamping. */
  maxBoxScale: number;
  /** Edge held fixed when a box is resized (clamp AND temporal stage).
   *  Default center/center — the legacy center-preserving behavior. */
  resizeAnchor?: ResizeAnchor;
  /** Median window override; <= 1 disables the temporal stage (clamp-only,
   *  the pre-temporal-smoothing behavior — the report harness's "shipped"
   *  variant). Default SIZE_MEDIAN_WINDOW. */
  temporalWindow?: number;
}

export type ResizeAnchorX = "left" | "center" | "right";
export type ResizeAnchorY = "top" | "center" | "bottom";

/** Which box edge stays FIXED when a sample's w/h is rewritten (clamp or
 *  temporal smoothing). Derived from the overlay's follow offset — the edge
 *  the user's content references is the one that must not move. Default
 *  center/center = the legacy center-preserving behavior. */
export interface ResizeAnchor {
  x: ResizeAnchorX;
  y: ResizeAnchorY;
}

export const CENTER_RESIZE_ANCHOR: ResizeAnchor = { x: "center", y: "center" };

/** |offset| (in art-box fractions) beyond which the offset direction is
 *  treated as deliberate "sit above/below/beside the subject" intent. */
export const RESIZE_ANCHOR_OFFSET_THRESHOLD = 0.25;

/** Derive the stable reference edge from the overlay's follow offset.
 *  `{y:-0.5}` (content ABOVE the box, e.g. an arrow over a head) means the
 *  box TOP is what the user aligned to — holding the top fixed while
 *  smoothing the detector's height flap is what stops the content bouncing.
 *  No/small offset ⇒ center (legacy; also the safe default for a raised-arm
 *  person box whose top edge can transiently become a hand). */
export function resizeAnchorFromOffset(
  offset?: { x: number; y: number } | null,
): ResizeAnchor {
  if (!offset) return CENTER_RESIZE_ANCHOR;
  const T = RESIZE_ANCHOR_OFFSET_THRESHOLD;
  return {
    x: offset.x <= -T ? "left" : offset.x >= T ? "right" : "center",
    y: offset.y <= -T ? "top" : offset.y >= T ? "bottom" : "center",
  };
}

/** Rewrite a sample's box to (nw, nh) holding the anchored edge fixed.
 *  Same-ref when dims are unchanged (memoization-critical — mirrors the
 *  One-Euro constant-passthrough exactness contract). */
export function resizeBox(
  s: TrackSample,
  nw: number,
  nh: number,
  anchor: ResizeAnchor,
): TrackSample {
  if (nw === s.w && nh === s.h) return s;
  const x =
    anchor.x === "left" ? s.x
    : anchor.x === "right" ? s.x + s.w - nw
    : s.x + s.w / 2 - nw / 2;
  const y =
    anchor.y === "top" ? s.y
    : anchor.y === "bottom" ? s.y + s.h - nh
    : s.y + s.h / 2 - nh / 2;
  return { ...s, x, y, w: nw, h: nh };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** Robust median (w,h) over visible, non-degenerate samples. null if none. */
export function robustMedianWH(samples: TrackSample[]): { w: number; h: number } | null {
  const ok = samples.filter((s) => s.visible && s.w > 0 && s.h > 0);
  if (ok.length === 0) return null;
  return { w: median(ok.map((s) => s.w)), h: median(ok.map((s) => s.h)) };
}

function clampDim(v: number, med: number, maxBoxScale: number): number {
  const hi = med * maxBoxScale;
  const lo = med / maxBoxScale;
  return Math.min(hi, Math.max(lo, v));
}

const usable = (s: TrackSample): boolean => s.visible && s.w > 0 && s.h > 0;

function pinEps(track: Track): number {
  return track.framerate > 0 ? 0.5 / track.framerate : 1e-4;
}

function segmentBoundaries(track: Track): number[] {
  const ts = new Set<number>();
  for (const seg of track.segments ?? []) ts.add(seg.startTime);
  return [...ts].sort((a, b) => a - b);
}

/** Contiguous index runs of usable samples the temporal median may smooth
 *  WITHIN. Runs break at (mirroring stabilizeTrackPosition's reset points):
 *  unusable samples, gaps > POSITION_RESET_GAP_SEC, crossed segment
 *  startTimes — and a manual pin is ISOLATED as a single-index run, because
 *  a pin is ground truth including its SIZE and must pass through verbatim. */
export function medianRuns(track: Track, samples: TrackSample[]): number[][] {
  const eps = pinEps(track);
  const pins = (track.manualAnchors ?? []).map((a) => a.time);
  const boundaries = segmentBoundaries(track);
  const isPin = (t: number) => pins.some((p) => Math.abs(t - p) <= eps);

  const runs: number[][] = [];
  let cur: number[] = [];
  let prevT: number | null = null;
  const flush = () => {
    if (cur.length) runs.push(cur);
    cur = [];
  };
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!usable(s)) {
      flush();
      prevT = null;
      continue;
    }
    const crossed = prevT !== null && boundaries.some((b) => prevT! < b && b <= s.t);
    const gap = prevT !== null && s.t - prevT > POSITION_RESET_GAP_SEC;
    if (crossed || gap) flush();
    if (isPin(s.t)) {
      flush();
      runs.push([i]);
      prevT = s.t;
      continue;
    }
    cur.push(i);
    prevT = s.t;
  }
  flush();
  return runs;
}

/**
 * Render-time size policy — TWO stages, both resizing via `resizeBox` so the
 * anchored edge (offset-implied stable edge; default center = legacy) never
 * moves:
 *   1. Envelope clamp: per-frame outlier rejection into
 *      robustMedianWH × [1/maxBoxScale, maxBoxScale] (unchanged semantics).
 *   2. Temporal median (temporalWindow > 1): a centered sliding median over
 *      w/h within reset runs replaces each frame's dims, so the detector's
 *      fast head↔head+neck size flap cannot reach the render. Holding the
 *      stable edge is what turns size smoothing into position stabilization:
 *      center = stable edge ± median(h)/2 (the residual-bounce fix).
 * The window shrinks SYMMETRICALLY at run edges (always odd, centered): the
 * first sample after a reset passes through exactly (One-Euro reset parity)
 * and a monotone size trend is the identity (no lag).
 * `segments[].samples` get stage 1 only — they are provenance/quality data;
 * a stateful temporal filter is only meaningful over the stitched render
 * sequence (same rationale as stabilizeTrackPosition).
 * `mode:"raw"`, no usable envelope, and no-change runs return the SAME track
 * ref (memoization).
 */
export function stabilizeTrackSize(track: Track, opts: SizeStabilizeOpts): Track {
  if (opts.mode === "raw") return track;
  const env = robustMedianWH(track.samples);
  if (!env) return track;
  const anchor = opts.resizeAnchor ?? CENTER_RESIZE_ANCHOR;
  const win = opts.temporalWindow ?? SIZE_MEDIAN_WINDOW;

  const clampFix = (s: TrackSample): TrackSample => {
    if (!usable(s)) return s;
    return resizeBox(
      s,
      clampDim(s.w, env.w, opts.maxBoxScale),
      clampDim(s.h, env.h, opts.maxBoxScale),
      anchor,
    );
  };

  // Stage 1 — envelope clamp.
  const clamped = track.samples.map(clampFix);

  // Stage 2 — temporal median within reset runs.
  let samples = clamped;
  if (win > 1) {
    const half = Math.floor(win / 2);
    const out = clamped.slice();
    for (const run of medianRuns(track, clamped)) {
      if (run.length < 2) continue;
      for (let k = 0; k < run.length; k++) {
        const r = Math.min(half, k, run.length - 1 - k);
        if (r === 0) continue; // run edge: pass through exactly
        const ws: number[] = [];
        const hs: number[] = [];
        for (let j = k - r; j <= k + r; j++) {
          ws.push(clamped[run[j]].w);
          hs.push(clamped[run[j]].h);
        }
        out[run[k]] = resizeBox(clamped[run[k]], median(ws), median(hs), anchor);
      }
    }
    samples = out;
  }

  const samplesChanged = samples.some((s, i) => s !== track.samples[i]);

  const oldSegs = track.segments ?? [];
  const segFixed = oldSegs.map((seg) => {
    const ss = seg.samples.map(clampFix);
    return ss.some((s, i) => s !== seg.samples[i]) ? { ...seg, samples: ss } : seg;
  });
  const segmentsChanged = segFixed.some((seg, i) => seg !== oldSegs[i]);

  if (!samplesChanged && !segmentsChanged) return track;
  return { ...track, samples, segments: segFixed };
}
