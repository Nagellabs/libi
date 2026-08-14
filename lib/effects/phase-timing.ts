// lib/effects/phase-timing.ts
/** Pure mapping from composition-global time to a per-slot progress 0→1.
 *  Dependency-free on purpose. */

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Effective in/out window length in seconds: requested ms (default 400),
 *  clamped to the element duration. */
export function windowSeconds(durationMs: number | undefined, elementDuration: number): number {
  const reqSec = (durationMs ?? 400) / 1000;
  if (elementDuration <= 0) return 0;
  return Math.min(reqSec, elementDuration);
}

/** Progress 0→1 across the in-window at the START of the element. */
export function inProgress(
  globalTime: number,
  startTime: number,
  elementDuration: number,
  durationMs: number | undefined,
): number {
  const w = windowSeconds(durationMs, elementDuration);
  if (w <= 0) return 1;
  return clamp01((globalTime - startTime) / w);
}

/** Progress 0→1 across the out-window at the END of the element (1 exactly at end). */
export function outProgress(
  globalTime: number,
  startTime: number,
  elementDuration: number,
  durationMs: number | undefined,
): number {
  const w = windowSeconds(durationMs, elementDuration);
  if (w <= 0) return 0;
  const end = startTime + elementDuration;
  const outStart = end - w;
  return clamp01((globalTime - outStart) / w);
}

/** Continuous wrapping phase 0→1 across a fixed period (seconds = periodMs/1000),
 *  measured from the element start. Seamless: phase(end-of-period) === phase(0). */
export function loopPhase(
  globalTime: number,
  startTime: number,
  periodMs: number | undefined,
): number {
  const period = (periodMs ?? 1000) / 1000;
  if (period <= 0) return 0;
  const local = globalTime - startTime;
  const frac = (local / period) % 1;
  return frac < 0 ? frac + 1 : frac;
}
