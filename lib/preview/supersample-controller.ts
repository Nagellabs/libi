/**
 * Pure adaptive-supersample controller for the preview canvas.
 *
 * The preview renders its canvas backing store at `displaySize × min(DPR, cap)`
 * so overlays are crisp on HiDPI screens (see PREVIEW_SUPERSAMPLE_CAP). On a
 * weak GPU with a large preview, that extra fill can drop frames. This
 * controller watches a per-second "stressed?" signal (fraction of frames whose
 * compositor time blew the frame budget) and lowers the effective cap toward 1
 * under sustained stress, restoring it with hysteresis once frames recover.
 *
 * Dependency-free and deterministic (mirrors the `decode-ahead` pump-decision
 * pattern) so it is unit-tested in isolation. The preview owns the I/O — it
 * samples the stats each `SUPERSAMPLE_TICK_MS`, calls `nextSupersample`, and
 * applies the returned cap to the canvas backing size.
 */

export interface SupersampleTuning {
  /** Upper bound of the effective cap (== PREVIEW_SUPERSAMPLE_CAP). */
  maxCap: number;
  /** Lower bound of the effective cap (1 = no supersample). */
  minCap: number;
  /** Consecutive stressed ticks before dropping maxCap → minCap. */
  dropTicks: number;
  /** Consecutive healthy ticks before restoring minCap → maxCap. */
  recoverTicks: number;
}

export interface SupersampleState {
  /** Current effective cap applied to the backing store. */
  cap: number;
  /** Consecutive stressed ticks seen so far. */
  stressStreak: number;
  /** Consecutive healthy ticks seen so far. */
  calmStreak: number;
}

export function initSupersampleState(maxCap: number): SupersampleState {
  return { cap: maxCap, stressStreak: 0, calmStreak: 0 };
}

/**
 * Advance the controller by one sampling tick.
 *
 * @param state    previous state
 * @param stressed whether this tick's frames were sustained-slow (the preview
 *                 computes `slowFraction >= SUPERSAMPLE_SLOW_FRACTION`)
 * @param cfg      thresholds
 * @returns the next state (same object shape; `cap` is what to apply)
 */
export function nextSupersample(
  state: SupersampleState,
  stressed: boolean,
  cfg: SupersampleTuning,
): SupersampleState {
  if (stressed) {
    const stressStreak = state.stressStreak + 1;
    // Drop fast: one sustained-slow run collapses the cap to the floor.
    if (state.cap > cfg.minCap && stressStreak >= cfg.dropTicks) {
      return { cap: cfg.minCap, stressStreak: 0, calmStreak: 0 };
    }
    return { cap: state.cap, stressStreak, calmStreak: 0 };
  }
  const calmStreak = state.calmStreak + 1;
  // Recover slow: only after a longer healthy run, and one step at a time.
  if (state.cap < cfg.maxCap && calmStreak >= cfg.recoverTicks) {
    return { cap: cfg.maxCap, stressStreak: 0, calmStreak: 0 };
  }
  return { cap: state.cap, stressStreak: 0, calmStreak };
}
