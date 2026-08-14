import type { TrackSample } from "@/lib/tracking/types";

export interface SanitizeOpts {
  frameW: number;
  frameH: number;
  clipDurationSec: number;
  /** Box area fraction of the frame at/above which a "single subject"
   *  detection is treated as a collapse (not a real subject). */
  maxAreaFraction?: number;
  /** Small slack so t == duration isn't dropped by float error. */
  durationSlackSec?: number;
}

/**
 * Honest-output contract. Never let a degenerate (≈full-frame) box claim
 * visible:true, and never emit samples past the clip. Pure.
 */
export function sanitizeSamples(samples: TrackSample[], opts: SanitizeOpts): TrackSample[] {
  const maxArea = (opts.maxAreaFraction ?? 0.9) * opts.frameW * opts.frameH;
  const slack = opts.durationSlackSec ?? 0.05;
  const out: TrackSample[] = [];
  for (const s of samples) {
    if (s.t > opts.clipDurationSec + slack) continue;
    const area = Math.max(0, s.w) * Math.max(0, s.h);
    if (s.visible && area >= maxArea) {
      out.push({ ...s, visible: false, confidence: 0 });
    } else {
      out.push(s);
    }
  }
  return out;
}
