import type { TrackSample } from "@/lib/tracking/types";

/** Longest visible→visible outage (seconds) that may be bridged, measured
 *  as the time between the last good box before the gap and the first good
 *  box after it. Sized to the observed cameraman-pass flicker (~0.4s on the
 *  Lisa footage: a few no-detection frames bracketed by good detections).
 *  Anything longer is a genuine loss and stays an honest gap. The
 *  same-subject bracket check below is what actually prevents bridging an
 *  identity change — this bound just keeps it to a brief flicker. */
export const SHORT_OCCLUSION_MAX_SEC = 0.4;

/** Bracketing boxes must be this close (center distance ≤ frac × the
 *  smaller box's larger dimension) AND similar in size to count as the
 *  SAME subject across the gap — otherwise the gap spans an identity
 *  change and must not be bridged. */
const SAME_SUBJECT_CENTER_FRAC = 1.0;
const SAME_SUBJECT_SIZE_RATIO = 2.0;

function lerp(a: number, b: number, f: number) {
  return a + (b - a) * f;
}

function sameSubject(a: TrackSample, b: TrackSample): boolean {
  if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) return false;
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  const dist = Math.hypot(bcx - acx, bcy - acy);
  const scale = Math.min(Math.max(a.w, a.h), Math.max(b.w, b.h));
  if (dist > SAME_SUBJECT_CENTER_FRAC * scale) return false;
  const wr = a.w / b.w, hr = a.h / b.h;
  const inBand = (r: number) =>
    r >= 1 / SAME_SUBJECT_SIZE_RATIO && r <= SAME_SUBJECT_SIZE_RATIO;
  return inBand(wr) && inBand(hr);
}

/**
 * Bridge brief occlusions so a tracked overlay does not flicker off for a
 * fraction of a second when something (a cameraman, a passing dancer)
 * crosses in front of the subject. A maximal run of `visible:false`
 * samples is bridged ONLY when it is (a) short (≤ SHORT_OCCLUSION_MAX_SEC
 * between the bracketing visible samples) and (b) bracketed on BOTH sides
 * by visible samples that are the SAME subject (close center, similar
 * size). Bridged samples are honest: `confidence:0` (held, not detected)
 * and `targetSim:null` (no appearance claim) — so the quality summary
 * treats them as occlusion, never a detection or an identity switch.
 * Longer gaps, gaps with no bracket (leading/trailing), or gaps whose
 * brackets are a different subject are left as honest gaps.
 *
 * Pure; expects time-sorted input, returns a new array (same order).
 */
export function bridgeShortOcclusions(
  samples: TrackSample[],
  opts: { maxGapSec?: number } = {},
): TrackSample[] {
  const maxGap = opts.maxGapSec ?? SHORT_OCCLUSION_MAX_SEC;
  const out = samples.slice();
  let i = 0;
  while (i < out.length) {
    if (out[i].visible) {
      i++;
      continue;
    }
    // [start, end] is a maximal invisible run.
    const start = i;
    let end = i;
    while (end + 1 < out.length && !out[end + 1].visible) end++;
    const L = start - 1 >= 0 ? out[start - 1] : null;
    const R = end + 1 < out.length ? out[end + 1] : null;
    if (
      L &&
      R &&
      L.visible &&
      R.visible &&
      R.t - L.t <= maxGap &&
      sameSubject(L, R)
    ) {
      for (let k = start; k <= end; k++) {
        const s = out[k];
        const f = R.t === L.t ? 0 : (s.t - L.t) / (R.t - L.t);
        out[k] = {
          ...s,
          x: lerp(L.x, R.x, f),
          y: lerp(L.y, R.y, f),
          w: lerp(L.w, R.w, f),
          h: lerp(L.h, R.h, f),
          confidence: 0,
          visible: true,
          targetSim: null,
        };
      }
    }
    i = end + 1;
  }
  return out;
}
