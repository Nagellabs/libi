import type { EffectPhase } from "@/lib/effects/types";
import { windowSeconds } from "@/lib/effects/phase-timing";

/** Floor so even a very short effect plays long enough to perceive (not a flash). */
export const MIN_PREVIEW_SEC = 0.3;

export interface EffectPreviewWindowInput {
  /** Element (overlay/audio-clip) absolute start in composition seconds. */
  elementStart: number;
  /** Element duration in seconds. */
  elementDuration: number;
  /** Which family was selected — `reveal` spans the whole element. */
  family: "animation" | "reveal" | "custom";
  /** in/out/loop slot — required for non-reveal families. */
  phase?: EffectPhase;
  /** Selected ref's override duration (ms), if any. */
  durationMs?: number;
  /** Effect meta default duration (ms), if any. */
  defaultDurationMs?: number;
}

/**
 * The time window (composition seconds) to play when an effect is selected:
 * - `reveal` → the whole element (reveals run across the caption).
 * - `in`     → head `[start, start + window]`.
 * - `out`    → tail `[end - window, end]`.
 * - `loop`   → from start for one period.
 * `window`/period length = effective ms (override → default → 400 / 1000),
 * clamped to the element and floored to MIN_PREVIEW_SEC. Returns null when the
 * element has no duration.
 */
export function effectPreviewWindowSec(
  input: EffectPreviewWindowInput,
): { startSec: number; endSec: number } | null {
  const { elementStart, elementDuration, family, phase, durationMs, defaultDurationMs } = input;
  if (elementDuration <= 0) return null;
  const end = elementStart + elementDuration;

  const floored = (raw: number) => Math.min(elementDuration, Math.max(MIN_PREVIEW_SEC, raw));

  if (family === "reveal") {
    return { startSec: elementStart, endSec: end };
  }

  const effMs = durationMs ?? defaultDurationMs;

  if (phase === "out") {
    const w = floored(windowSeconds(effMs, elementDuration));
    return { startSec: end - w, endSec: end };
  }
  if (phase === "loop") {
    const period = (effMs ?? 1000) / 1000;
    const len = floored(period);
    return { startSec: elementStart, endSec: elementStart + len };
  }
  // default: "in"
  const w = floored(windowSeconds(effMs, elementDuration));
  return { startSec: elementStart, endSec: elementStart + w };
}
