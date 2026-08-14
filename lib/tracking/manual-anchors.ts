// Intentional lib/tracking → lib/engine import: reuse the EXACT renderer
// transform (resolveTrackedRect = applyFitAndScale + follow offset) so the
// closed-loop invariant (recovered bbox → resolveTrackedRect → drop point)
// is guaranteed rather than re-derived. No cycle:
// overlay-renderer → sample → types, none import back here.
import { resolveTrackedRect } from "@/lib/engine/overlay-renderer";
import type { AgentAnchor, ManualAnchor, Track, TrackFit, TrackSample } from "@/lib/tracking/types";

/** Max factor an anchor box may exceed the local track-size envelope before
 *  its w/h is clamped (center preserved). */
export const ANCHOR_SIZE_RATIO = 1.6;

function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** Robust median (w,h) of visible, non-degenerate samples within ±windowSec
 *  of `time`; falls back to the whole track; null when none usable. */
export function localSizeEnvelope(
  samples: TrackSample[],
  time: number,
  windowSec: number,
): { w: number; h: number } | null {
  const usable = (arr: TrackSample[]) =>
    arr.filter((s) => s.visible && s.w > 0 && s.h > 0);
  let pool = usable(samples.filter((s) => Math.abs(s.t - time) <= windowSec));
  if (pool.length === 0) pool = usable(samples);
  if (pool.length === 0) return null;
  return { w: medianOf(pool.map((s) => s.w)), h: medianOf(pool.map((s) => s.h)) };
}

/** Clamp an anchor box's w/h into the envelope × [1/ratio, ratio], keeping
 *  the box CENTER fixed (the anchor's position is the user/agent intent).
 *  No envelope ⇒ returned unchanged (cannot do better honestly). */
function reconcileAnchorBbox(
  bbox: [number, number, number, number],
  env: { w: number; h: number } | null,
): [number, number, number, number] {
  if (!env) return bbox;
  const [x, y, w, h] = bbox;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const cl = (v: number, m: number) =>
    Math.min(m * ANCHOR_SIZE_RATIO, Math.max(m / ANCHOR_SIZE_RATIO, v));
  const nw = cl(w, env.w);
  const nh = cl(h, env.h);
  return [cx - nw / 2, cy - nh / 2, nw, nh];
}

/** Deterministic id so a second drag on the same frame REPLACES the prior
 *  anchor instead of stacking. */
export function manualAnchorId(time: number): string {
  return `man-${Math.round(time * 1000)}`;
}

/** Replace-or-insert by id, returning a new array sorted by time. */
export function upsertManualAnchor(
  anchors: ManualAnchor[],
  next: ManualAnchor,
): ManualAnchor[] {
  const without = anchors.filter((a) => a.id !== next.id);
  return [...without, next].sort((a, b) => a.time - b.time);
}

/** Remove by id (no-op if absent). New array. */
export function removeManualAnchor(
  anchors: ManualAnchor[],
  id: string,
): ManualAnchor[] {
  return anchors.filter((a) => a.id !== id);
}

/** Deterministic id so a second agent re-anchor on the same frame REPLACES
 *  the prior instead of stacking (mirrors manualAnchorId). */
export function agentAnchorId(time: number): string {
  return `agt-${Math.round(time * 1000)}`;
}

/** Replace-or-insert by id, returning a new array sorted by time
 *  (mirrors upsertManualAnchor). */
export function upsertAgentAnchor(
  anchors: AgentAnchor[],
  next: AgentAnchor,
): AgentAnchor[] {
  const without = anchors.filter((a) => a.id !== next.id);
  return [...without, next].sort((a, b) => a.time - b.time);
}

/** Symmetric ±W seconds bound for a manual re-anchor's seeded re-track. A
 *  manual pin is a LOCAL correction: never re-track more than ±W around it
 *  and never spill outside the containing OK segment (see `reanchorWindow`).
 *  Bounding it is what stops one pin from re-tracking — and potentially
 *  destroying — the whole clip. */
export const REANCHOR_WINDOW_SEC = 3;

export interface RecoverManualBboxOpts {
  /** Current sampled bbox at the drag time, or null when the track is lost. */
  sample: Pick<TrackSample, "x" | "y" | "w" | "h"> | null;
  fit: TrackFit;
  scale: number;
  rect: { x: number; y: number; width: number; height: number };
  frame: { width: number; height: number };
  /** Where the user released the art, in composition pixels. */
  dropCenter: { x: number; y: number };
  /** Used only when `sample` is null — size the manual box from here. */
  fallbackSize?: { w: number; h: number };
  /** The overlay's follow offset (fractions of the resolved art box). The art
   *  the user grabbed RENDERS with it, so the implied subject bbox must
   *  subtract it. Absent ⇒ {0,0}. Safe for the translation-equivariance
   *  argument below: the offset in px depends only on the box DIMENSIONS
   *  (offset.x·art.w), never its position. */
  offset?: { x: number; y: number };
}

/**
 * Recover the subject bbox the user implied by dragging the rendered art.
 * The drag is a translation: keep the sampled w/h, shift the bbox center by
 * (dropCenter - currentArtCenter).
 *
 * Why this works: resolveTrackedRect (applyFitAndScale + follow offset) is
 * TRANSLATION-EQUIVARIANT for every fit. The art center is sampleCenter +
 * offset(w,h): for tight/rect the fit offset is zero (art center == sample
 * center); for head it is a nonzero vertical offset, but that offset depends
 * ONLY on the box dimensions, never on the box position; the follow offset is
 * likewise dimension-only (offset.x·art.w); clampToFrame shrinks uniformly
 * about the center. Holding w/h fixed and translating the sample by Δ
 * therefore translates the art center by exactly Δ — so no fit-specific
 * inverse is needed.
 * NOTE: a future fit whose offset depended on sample POSITION (not just w/h)
 * would break this and require an explicit per-fit inverse here.
 *
 * Returns [x,y,w,h] in TrackSample coordinate space.
 */
export function recoverManualBbox(opts: RecoverManualBboxOpts): [number, number, number, number] {
  const { sample, fit, scale, rect, frame, dropCenter } = opts;
  if (!sample) {
    const w = opts.fallbackSize?.w ?? rect.width;
    const h = opts.fallbackSize?.h ?? rect.height;
    return [dropCenter.x - w / 2, dropCenter.y - h / 2, w, h];
  }
  const art = resolveTrackedRect(
    { x: sample.x, y: sample.y, w: sample.w, h: sample.h },
    { rect, fit, scale, offset: opts.offset },
    frame,
  );
  const artCx = art.x + art.w / 2;
  const artCy = art.y + art.h / 2;
  const dx = dropCenter.x - artCx;
  const dy = dropCenter.y - artCy;
  return [sample.x + dx, sample.y + dy, sample.w, sample.h];
}

/**
 * The re-track window for a manual anchor: the `status:"ok"` segment whose
 * [startTime,endTime] contains `time`; otherwise `[time-W, time+W]` clamped
 * to `[0, durationSec]`.
 */
/**
 * The bounded window a manual re-anchor at `time` re-tracks: ±`windowSec`
 * around the pin, clamped so it never spills outside the containing OK
 * segment (or, when the pin is outside every OK segment, clamped to
 * [0, durationSec] with a degenerate-track fallback of `time + windowSec`).
 *
 * SINGLE SOURCE OF TRUTH: `recomputeTrackSegmentServerSide` re-tracks exactly
 * this window, and the "Re-track from corrections" route dedups by it — they
 * MUST agree, so both call this. (Inclusive `time >= start && time <= end`
 * segment match; a boundary time matches the earlier segment first.)
 */
export function reanchorWindow(
  track: Track,
  time: number,
  windowSec: number,
): { start: number; end: number } {
  const containing = (track.segments ?? []).find(
    (s) => s.status === "ok" && time >= s.startTime && time <= s.endTime,
  );
  const segStart = containing ? containing.startTime : 0;
  const segEnd = containing
    ? containing.endTime
    : track.durationSec > 0
      ? track.durationSec
      : time + windowSec;
  return {
    start: Math.max(segStart, time - windowSec),
    end: Math.min(segEnd, time + windowSec),
  };
}

/** Window each side of an agent anchor in which a confident engine sample
 *  counts as "the engine re-track has this moment". */
const ANCHOR_LOCAL_WINDOW_S = 0.25;
/** Horizontal separation (in local-box widths) above which the engine box
 *  and the anchor are different subjects → the engine re-track went wrong. */
const ANCHOR_SAME_SUBJECT_FRAC = 1.0;

/** Nearest confident, visible, non-degenerate sample within ±windowS. */
function nearestConfidentSample(
  samples: TrackSample[],
  time: number,
  windowS: number,
): TrackSample | null {
  let best: TrackSample | null = null;
  let bestDt = Infinity;
  for (const s of samples) {
    if (!s.visible || s.w <= 0 || s.h <= 0) continue;
    const dt = Math.abs(s.t - time);
    if (dt <= windowS && dt < bestDt) {
      best = s;
      bestDt = dt;
    }
  }
  return best;
}

/**
 * Point-stamp `anchors` into the track as authoritative high-confidence
 * visible keyframes. Derived samples within half a frame period of an anchor
 * are dropped to avoid duplicate-time points; `sampleTrack`'s interpolation
 * then eases neighbours toward the pin.
 *
 * Manual mode (default): the box is the user's literal correction
 * (size-reconciled to the local envelope, centre preserved) — unchanged.
 *
 * Agent mode: agent anchors are whole-person boxes from ground_target /
 * analysis. The engine head re-track (run by compute_track_segment, seeded
 * by these anchors) is the source of truth. The render override only steps
 * in where that re-track is provably wrong:
 *  - confident engine box AGREES horizontally with the anchor → SKIP (trust
 *    the engine's per-frame head boxes; this is what removes the flicker);
 *  - confident engine box DISAGREES (engine re-bound to the wrong subject)
 *    → stamp a HEAD box: anchor's horizontal centre, the engine box's head
 *    size and head LEVEL (never the person-box torso centre);
 *  - engine locally lost → derive a head from the person box: track-median
 *    head size at the TOP of the person box.
 *
 * Pure; SAME track ref when nothing is injected (callers rely on === for
 * memoization).
 */
function injectAnchorsIntoTrack(
  track: Track,
  anchors: Array<{ time: number; bbox: [number, number, number, number] }>,
  opts: { agentMode?: boolean } = {},
): Track {
  if (anchors.length === 0) return track;
  const eps = track.framerate > 0 ? 0.5 / track.framerate : 0.0001;
  const agentMode = opts.agentMode === true;

  /** Stamped box for an anchor, or null to SKIP it (agent: engine already
   *  has this subject here — trust the engine head re-track). */
  const boxFor = (
    samples: TrackSample[],
    a: { time: number; bbox: [number, number, number, number] },
  ): { x: number; y: number; w: number; h: number } | null => {
    if (!agentMode) {
      const env = localSizeEnvelope(samples, a.time, 0.5);
      const [bx, by, bw, bh] = reconcileAnchorBbox(a.bbox, env);
      return { x: bx, y: by, w: bw, h: bh };
    }
    const ax = a.bbox[0] + a.bbox[2] / 2;
    const loc = nearestConfidentSample(samples, a.time, ANCHOR_LOCAL_WINDOW_S);
    if (loc) {
      const locCx = loc.x + loc.w / 2;
      if (Math.abs(ax - locCx) <= ANCHOR_SAME_SUBJECT_FRAC * loc.w) {
        return null; // engine re-track already on this subject → trust it
      }
      // Engine confidently on the WRONG subject: correct horizontally onto
      // the anchor; keep the engine's head SIZE and head LEVEL.
      return { x: ax - loc.w / 2, y: loc.y, w: loc.w, h: loc.h };
    }
    // Engine locally lost: head from the TOP of the person box, track-sized.
    const env = localSizeEnvelope(samples, a.time, 0.5);
    if (env) return { x: ax - env.w / 2, y: a.bbox[1], w: env.w, h: env.h };
    const [bx, by, bw, bh] = reconcileAnchorBbox(a.bbox, null);
    return { x: bx, y: by, w: bw, h: bh };
  };

  // Returns the SAME array ref when nothing is injected (memoization-safe).
  const injectFor = (
    samples: TrackSample[],
    forAnchors: Array<{ time: number; bbox: [number, number, number, number] }>,
  ): TrackSample[] => {
    const injected: Array<{
      t: number;
      box: { x: number; y: number; w: number; h: number };
    }> = [];
    for (const a of forAnchors) {
      const box = boxFor(samples, a);
      if (box) injected.push({ t: a.time, box });
    }
    if (injected.length === 0) return samples;
    const acc = samples.filter(
      (s) => !injected.some((a) => Math.abs(s.t - a.t) < eps),
    );
    for (const { t, box } of injected) {
      acc.push({
        t, x: box.x, y: box.y, w: box.w, h: box.h,
        confidence: 1, visible: true,
      });
    }
    return acc.sort((p, q) => p.t - q.t);
  };

  let anyInjected = false;
  const newSamples = injectFor(track.samples, anchors);
  if (newSamples !== track.samples) anyInjected = true;

  const segments = (track.segments ?? []).map((seg) => {
    const segAnchors = anchors.filter(
      (a) => a.time >= seg.startTime && a.time <= seg.endTime && seg.status === "ok",
    );
    if (segAnchors.length === 0) return seg;
    const segSamples = injectFor(seg.samples, segAnchors);
    if (segSamples === seg.samples) return seg;
    anyInjected = true;
    return { ...seg, samples: segSamples };
  });

  if (!anyInjected) return track; // nothing changed — preserve ref
  return { ...track, segments, samples: newSamples };
}

/**
 * A manual pin is CONSUMED once its seeded re-track has landed: a
 * `provenance:"manual"` OK segment covers the pin's time, was written at or
 * after the pin was placed, and has a visible sample at the pin instant.
 *
 * Why this matters (the re-anchor JUMP bug): the write path deliberately
 * accepts detector boxes within ANCHOR_POS_TOLERANCE_FRAC (1.5×) of the pin
 * trajectory — the pin STEERS the re-track, the detector box is the accurate
 * placement. Re-stamping the raw pin verbatim at render (zero tolerance)
 * contradicts that acceptance: `sampleTrack` eases into the stamped point
 * over ±1 frame, so any pin↔re-track residual renders as a 1-2 frame
 * positional spike at exactly the re-anchor moment (270px on real footage).
 * A consumed pin's segment IS its truth (detector-refined, or pin-ridden via
 * fillNoDetectionFromAnchors when the engine saw nothing) — skip the stamp.
 *
 * An UNconsumed pin still stamps: a fresh drag whose re-track hasn't landed
 * (optimistic snap), a re-track that bailed with nothing visible (the
 * honest engine-failed override), or a gate-blanked instant.
 */
export function isManualAnchorConsumed(track: Track, anchor: ManualAnchor): boolean {
  const eps = track.framerate > 0 ? 0.5 / track.framerate : 0.0001;
  return (track.segments ?? []).some(
    (seg) =>
      seg.provenance === "manual" &&
      seg.status === "ok" &&
      anchor.time >= seg.startTime &&
      anchor.time <= seg.endTime &&
      (seg.createdAt ?? 0) >= (anchor.createdAt ?? 0) &&
      seg.samples.some((s) => s.visible && Math.abs(s.t - anchor.time) <= eps),
  );
}

/** The manual anchors that should still be render-stamped (unconsumed). */
function stampableManualAnchors(track: Track): ManualAnchor[] {
  return (track.manualAnchors ?? []).filter((a) => !isManualAnchorConsumed(track, a));
}

/**
 * Render-time manual override: point-stamps the UNCONSUMED
 * `track.manualAnchors` (see `isManualAnchorConsumed`). SAME ref when there
 * is nothing to stamp.
 */
export function mergeManualAnchorsIntoTrack(track: Track): Track {
  return injectAnchorsIntoTrack(track, stampableManualAnchors(track));
}

/**
 * Render-time combined override. Precedence: manual > agent > engine.
 * Agent anchors go through the engine-trust path (agentMode); manual anchors
 * are the user's literal truth while unconsumed (see
 * `isManualAnchorConsumed`). Manual is injected last so its eps filter drops
 * any agent point at the same time → manual wins. SAME track ref when
 * nothing is injected by either channel (memoization).
 */
export function mergeAnchorOverridesIntoTrack(track: Track): Track {
  const agent = track.agentAnchors ?? [];
  const manual = stampableManualAnchors(track);
  if (agent.length === 0 && manual.length === 0) return track;
  const withAgent = injectAnchorsIntoTrack(track, agent, { agentMode: true });
  return injectAnchorsIntoTrack(withAgent, manual);
}
