// One-Euro filter (Casiez, Roussel, Vogel — CHI 2012): a speed-adaptive
// first-order low-pass. At low speed the cutoff falls to `minCutoff`
// (strong smoothing — rock-steady on a still subject); as speed rises the
// cutoff grows by `beta`·|speed| (weak smoothing — no perceptible lag on a
// fast pan). This is the standard pointing/tracking jitter filter and the
// core of render-time tracked-overlay position stabilization
// (lib/tracking/position-stabilize.ts).
//
// Pure + dependency-free: runs in the browser export-render bundle and in
// node tests alike. Timestamps are SECONDS (same clock as TrackSample.t).

export interface OneEuroParams {
  /** Cutoff (Hz) at zero speed. Lower = steadier when the subject is still. */
  minCutoff: number;
  /** Cutoff gain per unit speed (Hz per px/s here). Higher = less lag when moving. */
  beta: number;
  /** Cutoff (Hz) of the speed (derivative) low-pass. */
  dCutoff: number;
}

/** Defaults tuned on real footage (plan Task 7, empirical sweep frontier-1):
 *  steady on trk-8802e213's jittery head (jitter 7.34→5.35px, −27%) while
 *  staying locked ON the subject — a stiller filter (lower minCutoff) lags
 *  the box off the head during real subject motion, and the old
 *  {1.0, 0.007, 1.0} default drifted UP off the head at t=8s. */
export const DEFAULT_ONE_EURO_PARAMS: OneEuroParams = {
  minCutoff: 1.0,
  beta: 0.05,
  dCutoff: 0.7,
};

function smoothingAlpha(cutoffHz: number, dtSec: number): number {
  const r = 2 * Math.PI * cutoffHz * dtSec;
  return r / (r + 1);
}

export class OneEuroFilter {
  /** Last RAW input — the derivative base (canonical One-Euro uses the raw
   *  previous value, not the filtered one). null ⇒ fresh/reset. */
  private prevRaw: number | null = null;
  private prevFiltered = 0;
  private prevDeriv = 0;
  private prevT = 0;

  constructor(private readonly params: OneEuroParams = DEFAULT_ONE_EURO_PARAMS) {}

  /** Drop all state — the next `filter()` call passes its input through
   *  exactly. Used at visibility gaps / segment joins / manual pins. */
  reset(): void {
    this.prevRaw = null;
    this.prevDeriv = 0;
  }

  /** Feed one measurement at time `t` (seconds, increasing between resets). */
  filter(value: number, t: number): number {
    if (this.prevRaw === null) {
      this.prevRaw = value;
      this.prevFiltered = value;
      this.prevDeriv = 0;
      this.prevT = t;
      return value;
    }
    const dt = t - this.prevT;
    if (!(dt > 0)) return this.prevFiltered; // duplicate/regressive timestamp: hold
    const rawDeriv = (value - this.prevRaw) / dt;
    const dAlpha = smoothingAlpha(this.params.dCutoff, dt);
    const deriv = this.prevDeriv + dAlpha * (rawDeriv - this.prevDeriv);
    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(deriv);
    const alpha = smoothingAlpha(cutoff, dt);
    // Incremental lerp form — EXACTNESS-CRITICAL: when value === prevFiltered
    // the delta is 0 and the output is bit-identical to the input. The
    // constant-passthrough test, stabilizeTrackPosition's same-ref
    // memoization, and verify-render parity on constant fixtures all rely on
    // this (the algebraically-equal `α·v + (1−α)·prev` form is NOT FP-exact).
    const filtered = this.prevFiltered + alpha * (value - this.prevFiltered);
    this.prevRaw = value;
    this.prevFiltered = filtered;
    this.prevDeriv = deriv;
    this.prevT = t;
    return filtered;
  }
}
