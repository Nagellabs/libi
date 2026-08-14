import type { TrackSample } from "@/lib/tracking/types";

type Box = { x: number; y: number; w: number; h: number };
type KnownBox = { t: number; box: Box };

function lerp(a: number, b: number, f: number) {
  return a + (b - a) * f;
}

/**
 * Manual re-anchor must never make a window worse. Where the seeded re-track
 * produced a no-detection run (`visible:false`) at times the PRIOR derived
 * track was visible OR an in-range anchor explicitly asserts the subject,
 * ride the overlay through by interpolating a box from the nearest KNOWN
 * boxes — KNOWN = the user's in-range manual anchors ∪ the re-track's own
 * visible samples. Filled samples are honest: confidence 0 (held, not
 * detected) and targetSim null (no appearance match) so the summary
 * classifies them as occlusion, never identity-switch.
 *
 * **Fill condition:** a no-detection in-range sample is filled when the prior
 * track was visible there OR an in-range anchor asserts the subject is present
 * in this window (the user/agent explicitly pinned it). Only a window with NO
 * anchor AND no prior coverage stays an honest gap.
 *
 * **Precondition:** The "never fewer visible than prior" guarantee holds ONLY
 * when `anchors` is non-empty (or `newSamples` already has some visible
 * entries). With no anchors AND no visible new samples the known set is empty
 * and the function returns the input unchanged — callers (e.g. Task 6
 * recompute-segment) must supply in-range anchors for the fill to fire.
 *
 * Pure; returns a new array sorted by time.
 */
export function fillNoDetectionFromAnchors(args: {
  newSamples: TrackSample[];
  priorSamples: TrackSample[];
  anchors: { time: number; bbox: [number, number, number, number] }[];
  range: { start: number; end: number };
}): TrackSample[] {
  const { newSamples, priorSamples, anchors, range } = args;
  const known: KnownBox[] = [
    ...anchors.map((a) => ({
      t: a.time,
      box: { x: a.bbox[0], y: a.bbox[1], w: a.bbox[2], h: a.bbox[3] },
    })),
    ...newSamples
      .filter((s) => s.visible && s.w > 0 && s.h > 0)
      .map((s) => ({ t: s.t, box: { x: s.x, y: s.y, w: s.w, h: s.h } })),
  ].sort((a, b) => a.t - b.t);
  if (known.length === 0) return newSamples.slice().sort((a, b) => a.t - b.t);

  const priorVisibleAt = (t: number) =>
    priorSamples.some((p) => Math.abs(p.t - t) < 1e-6 && p.visible);

  const boxAt = (t: number): Box => {
    let lo: KnownBox | null = null;
    let hi: KnownBox | null = null;
    for (const k of known) {
      if (k.t <= t) lo = k;
      if (k.t >= t && !hi) hi = k;
    }
    if (lo && hi && lo !== hi && hi.t > lo.t) {
      const f = (t - lo.t) / (hi.t - lo.t);
      return {
        x: lerp(lo.box.x, hi.box.x, f),
        y: lerp(lo.box.y, hi.box.y, f),
        w: lerp(lo.box.w, hi.box.w, f),
        h: lerp(lo.box.h, hi.box.h, f),
      };
    }
    // single-sided OR coincident-t ⇒ carry nearest known (no divide-by-zero)
    return (lo ?? hi)!.box;
  };

  const anchored = anchors.some(
    (a) => a.time >= range.start && a.time <= range.end,
  );

  return newSamples
    .map((s) => {
      const inRange = s.t >= range.start && s.t <= range.end;
      if (s.visible || !inRange || (!priorVisibleAt(s.t) && !anchored)) return s;
      const b = boxAt(s.t);
      return {
        ...s,
        x: b.x, y: b.y, w: b.w, h: b.h,
        confidence: 0, visible: true, targetSim: null,
      };
    })
    .sort((a, b) => a.t - b.t);
}
