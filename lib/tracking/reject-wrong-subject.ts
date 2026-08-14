import type { TrackSample } from "@/lib/tracking/types";
import { APPEARANCE_TAU } from "@/lib/tracking/summary";

/** Minimum sustained duration (s) of a sub-τ visible run before we treat it
 *  as a wrong-subject lock rather than a transient appearance dip. Matches
 *  summarizeTrack's MIN_SWITCH_SEC so the write path and the report agree. */
export const WRONG_SUBJECT_MIN_SEC = 0.5;

/**
 * Write-path appearance enforcement. A re-track that comes back locked on a
 * DIFFERENT subject emits `visible:true` boxes whose appearance similarity to
 * the target template is sustained below APPEARANCE_TAU (the cameraman in the
 * Lisa repro: targetSim ~0.6 for ~2s). Rendering those is the "returns to the
 * wrong person" bug. Blank any sustained (≥WRONG_SUBJECT_MIN_SEC) run of
 * visible samples with a present targetSim < APPEARANCE_TAU to visible:false
 * so the overlay does not render the wrong subject; a later fill step may
 * ride the user's anchor through the now-empty window. Samples with a null
 * targetSim (no appearance signal — motion-only / held) are untouched.
 *
 * Pure; returns a new array (same order).
 */
export function rejectWrongSubjectRuns(samples: TrackSample[]): TrackSample[] {
  const low = (s: TrackSample) =>
    s.visible && s.targetSim != null && s.targetSim < APPEARANCE_TAU;
  const reject = new Set<number>();
  let runStart: number | null = null;
  let runIdx: number[] = [];
  const flush = (endT: number) => {
    if (runStart != null && endT - runStart >= WRONG_SUBJECT_MIN_SEC) {
      for (const i of runIdx) reject.add(i);
    }
    runStart = null;
    runIdx = [];
  };
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (low(s)) {
      if (runStart == null) runStart = s.t;
      runIdx.push(i);
    } else {
      flush(samples[i - 1]?.t ?? s.t);
    }
  }
  flush(samples[samples.length - 1]?.t ?? 0);
  if (reject.size === 0) return samples.slice();
  return samples.map((s, i) =>
    reject.has(i)
      ? { ...s, visible: false, confidence: 0 }
      : s,
  );
}
