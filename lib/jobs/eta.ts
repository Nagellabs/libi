/**
 * Rolling-window ETA. The old lifetime-average (`elapsed / done`) showed
 * "ETA 23.8 min" at 5/750 for a 74s tracking job because the first frames
 * absorb model load (QA 2026-07-04). The window only measures the RECENT
 * rate, and the gate keeps ETA absent until it is actually measurable —
 * per the spec's "honest or removed" rule.
 */
export interface EtaSample {
  t: number;
  done: number;
}

export const ETA_WINDOW_SAMPLES = 20;
export const ETA_MIN_SPAN_MS = 5_000;
export const ETA_MIN_DONE = 3;

export class EtaTracker {
  private samples: EtaSample[] = [];

  add(t: number, done: number): void {
    this.samples.push({ t, done });
    if (this.samples.length > ETA_WINDOW_SAMPLES) {
      this.samples.splice(0, this.samples.length - ETA_WINDOW_SAMPLES);
    }
  }

  msPerUnit(): number | null {
    if (this.samples.length < 2) return null;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dDone = last.done - first.done;
    const dT = last.t - first.t;
    if (dDone < 1 || dT < ETA_MIN_SPAN_MS) return null;
    return dT / dDone;
  }

  etaMs(total: number, doneNow: number): number | null {
    if (total <= 0 || doneNow < ETA_MIN_DONE) return null;
    const rate = this.msPerUnit();
    if (rate === null) return null;
    return Math.max(0, rate * (total - Math.min(doneNow, total)));
  }
}
