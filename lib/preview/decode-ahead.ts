/**
 * Pure decode-ahead control logic, kept dependency-free (no mediabunny / no
 * WebCodecs) so it is unit-testable in jsdom without loading the decoder stack.
 */
import { COVERAGE_EPS, BACKWARD_RESTART_TOLERANCE_SEC } from "@/lib/preview/tuning";

// Re-export so existing `from "@/lib/preview/decode-ahead"` import sites keep
// resolving COVERAGE_EPS; the value lives in tuning.ts (the single source).
export { COVERAGE_EPS, BACKWARD_RESTART_TOLERANCE_SEC };

/**
 * Does a request for time `t` fall OUTSIDE the ring's buffered span
 * `[earliest, covered]` (so the pump must clear + restart at `t`)?
 *
 * Decode-ahead means `covered` legitimately runs far AHEAD of `t` — that is NOT
 * a jump and returns false (otherwise the renderer's per-tick `seek(t)` would
 * thrash the pump). A restart is needed only for:
 *  - an empty ring (`covered === -Infinity`),
 *  - a backward jump before `earliest`, or
 *  - the playhead running PAST `covered` (underflow / forward jump).
 */
export function needsPumpRestart(
  t: number,
  earliest: number,
  covered: number,
  eps: number = COVERAGE_EPS,
  backwardTol: number = BACKWARD_RESTART_TOLERANCE_SEC,
): boolean {
  if (covered === -Infinity) return true;
  // Backward: only a MEANINGFUL jump before the window is a real scrub-back.
  // A sub-`backwardTol` gap is the seek-landing artifact (the decoder's first
  // frame after seeking to `trim.start` lands a few-dozen ms after it), which
  // must NOT clear the ring — see BACKWARD_RESTART_TOLERANCE_SEC.
  if (t < earliest - backwardTol) return true;
  if (t > covered + eps) return true;
  return false;
}

export type PumpAction = "ok" | "wait" | "restart";

/**
 * Decide what the decode-ahead pump should do to cover source-local time `t`,
 * given the ring's buffered span `[earliest, covered]`, the in-flight pump's
 * origin `pumpFrom` (null = no live pump), and the lookahead window.
 *
 *  - `ok`      — a decoded frame at `t` is already buffered; nothing to do.
 *  - `wait`    — a live pump heading FORWARD from `<= t` will reach `t` soon;
 *                don't restart (restarting starves it before its first push).
 *  - `restart` — clear + restart the pump at `t`.
 *
 * Critical case: when `t` is BEHIND the buffered window (`t < earliest`), a pump
 * that decoded ahead and parked will NEVER decode backward to fill `[t,
 * earliest]` — so this must be `restart`, never `wait`, or the ring stays stuck
 * ahead of the playhead and `getFrame` shows stale-ahead frames (the backward-
 * jump desync).
 */
export function pumpDecision(
  t: number,
  earliest: number,
  covered: number,
  pumpFrom: number | null,
  lookahead: number,
  eps: number = COVERAGE_EPS,
  backwardTol: number = BACKWARD_RESTART_TOLERANCE_SEC,
): PumpAction {
  if (!needsPumpRestart(t, earliest, covered, eps, backwardTol)) return "ok";
  // "Behind the window" only when the gap exceeds the backward tolerance (a
  // real scrub-back). A marginal seek-landing gap stays out of this branch so
  // it resolves to "wait"/"ok" instead of a ring-clearing restart.
  const behindWindow = covered !== -Infinity && t < earliest - backwardTol;
  const pumpHeadingHere =
    !behindWindow &&
    pumpFrom != null &&
    t >= pumpFrom - eps &&
    (covered === -Infinity || t <= covered + lookahead + 0.5);
  return pumpHeadingHere ? "wait" : "restart";
}
