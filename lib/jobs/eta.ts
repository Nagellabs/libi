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

/**
 * Remaining-time estimate, aged by how long we have been waiting for the next
 * tick. THE ONE implementation of the formula — the live emit path
 * (`EtaTracker.etaMs`) and the read path (`snapshotFromRow`) both call this, so
 * a chat row and `libi.get_job_status` can never quote different numbers for
 * the same job.
 *
 * `msSinceProgress` is what makes this honest, and omitting it is what made the
 * ACE-Step download read "ETA 1m 12s" for fifteen straight minutes
 * (session 9c3ce4d0, 2026-08-17). The old code only ever recomputed ETA when a
 * progress tick ARRIVED, so a job that goes quiet keeps quoting the estimate it
 * made before it went quiet — frozen, not counting down. Two consequences here:
 *
 *   1. The estimate DECAYS in real time. Predicted 60s, waited 20s → 40s left.
 *      The countdown keeps moving between ticks instead of standing still.
 *   2. An estimate the wait has already outlived is WITHDRAWN (null), not
 *      clamped to 0. Predicted 60s and 15 minutes have passed with no movement:
 *      we do not know how long is left, and saying "0s" or "1m 12s" both claim
 *      knowledge we don't have. Callers render no ETA at all.
 *
 * Note this cannot detect a stall on its own — it only knows what the caller
 * tells it via `msSinceProgress`. A caller that never re-asks still shows a
 * stale number, which is why JobManager re-emits on a heartbeat.
 */
export function remainingMs(opts: {
  total: number;
  done: number;
  msPerUnit: number | null;
  /** Wall-clock ms since the last progress tick. Omit when unknown — the
   *  estimate is then returned undecayed (old behaviour). */
  msSinceProgress?: number | null;
}): number | null {
  const { total, done, msPerUnit } = opts;
  if (total <= 0 || msPerUnit === null || msPerUnit <= 0) return null;
  const remainingUnits = total - Math.min(done, total);
  if (remainingUnits <= 0) return 0;
  const naive = remainingUnits * msPerUnit;
  const waited = opts.msSinceProgress;
  if (waited === null || waited === undefined) return Math.max(0, naive);
  // Disproven: we said `naive` and have already waited longer than that.
  if (waited >= naive) return null;
  return naive - waited;
}

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

  /** Timestamp of the most recent sample, or null when none have arrived. */
  lastSampleAt(): number | null {
    if (this.samples.length === 0) return null;
    return this.samples[this.samples.length - 1].t;
  }

  /**
   * `now` is optional only so existing callers that compute ETA at tick time
   * (where no time has passed yet) stay unchanged. Pass it whenever the ETA is
   * being read at a moment that is not itself a progress tick — otherwise the
   * decay above never applies and the estimate can freeze.
   */
  etaMs(total: number, doneNow: number, now?: number): number | null {
    if (total <= 0 || doneNow < ETA_MIN_DONE) return null;
    const rate = this.msPerUnit();
    if (rate === null) return null;
    const last = this.lastSampleAt();
    return remainingMs({
      total,
      done: doneNow,
      msPerUnit: rate,
      msSinceProgress: now !== undefined && last !== null ? now - last : null,
    });
  }
}
