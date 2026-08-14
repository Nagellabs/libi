import type { TrackSample } from "@/lib/tracking/types";

/** How far (in multiples of the local anchor-box size) a detected box's
 *  center may stray from the user's interpolated anchor trajectory before
 *  it is treated as a DIFFERENT subject. Generous on purpose: manual
 *  anchors are sparse and the real subject moves non-linearly between
 *  them, so this must only reject a box that has clearly jumped to
 *  another person (e.g. a cameraman crossing the frame), not normal
 *  motion off the straight chord between two pins. */
export const ANCHOR_POS_TOLERANCE_FRAC = 1.5;

interface AnchorPt {
  t: number;
  cx: number;
  cy: number;
  /** Larger box dimension — the distance scale at this time. NOTE: a tall
   *  full-body anchor (e.g. 130×400) makes the gate horizontally permissive
   *  by design (tol scales off the 400), so a same-row wrong subject can
   *  slip the positional gate — the appearance gate + fill are the
   *  complementary layers for that case. Not a bug; this gate's job is to
   *  catch a box that has clearly JUMPED away from the pin. */
  size: number;
}

function lerp(a: number, b: number, f: number) {
  return a + (b - a) * f;
}

/**
 * Appearance-INDEPENDENT positional gate for the manual re-anchor path.
 *
 * The OSNet appearance gate (targetSim < APPEARANCE_TAU) is blind whenever
 * the template is non-discriminative — on crowded footage a cameraman /
 * adjacent performer can score targetSim ~0.9 while standing well away from
 * where the user pinned the subject. `rejectWrongSubjectRuns` (sim-based)
 * therefore cannot catch it. This gate uses the user's manual anchors as
 * literal ground truth: any VISIBLE engine box inside the re-track window
 * whose center is farther than `toleranceFrac × localAnchorSize` from the
 * interpolated anchor trajectory is a different subject — blank it to
 * `visible:false, confidence:0` so `fillNoDetectionFromAnchors` can ride
 * the user's pin through. targetSim is intentionally never consulted here.
 *
 * Anchor-only reference (never the engine's own boxes — that would let the
 * wrong subject vote for itself). With no anchors there is no ground truth,
 * so samples are returned unchanged. Out-of-range and already-invisible
 * samples are untouched. Pure; preserves input order.
 */
export function rejectAnchorInconsistentBoxes(args: {
  samples: TrackSample[];
  anchors: { time: number; bbox: [number, number, number, number] }[];
  range: { start: number; end: number };
  toleranceFrac?: number;
}): TrackSample[] {
  const { samples, anchors, range } = args;
  const tol = args.toleranceFrac ?? ANCHOR_POS_TOLERANCE_FRAC;
  if (anchors.length === 0) return samples.slice();

  const pts: AnchorPt[] = anchors
    .map((a) => ({
      t: a.time,
      cx: a.bbox[0] + a.bbox[2] / 2,
      cy: a.bbox[1] + a.bbox[3] / 2,
      size: Math.max(a.bbox[2], a.bbox[3]),
    }))
    .sort((p, q) => p.t - q.t);

  const expectedAt = (t: number): AnchorPt => {
    let lo: AnchorPt | null = null;
    let hi: AnchorPt | null = null;
    for (const p of pts) {
      if (p.t <= t) lo = p;
      if (p.t >= t && !hi) hi = p;
    }
    if (lo && hi && lo !== hi && hi.t > lo.t) {
      const f = (t - lo.t) / (hi.t - lo.t);
      return {
        t,
        cx: lerp(lo.cx, hi.cx, f),
        cy: lerp(lo.cy, hi.cy, f),
        size: lerp(lo.size, hi.size, f),
      };
    }
    return (lo ?? hi)!; // single-sided or coincident-t ⇒ carry nearest pin
  };

  return samples.map((s) => {
    const inRange = s.t >= range.start && s.t <= range.end;
    if (!s.visible || !inRange) return s;
    const e = expectedAt(s.t);
    const scx = s.x + s.w / 2;
    const scy = s.y + s.h / 2;
    const dist = Math.hypot(scx - e.cx, scy - e.cy);
    if (dist > tol * e.size) {
      return { ...s, visible: false, confidence: 0 };
    }
    return s;
  });
}
