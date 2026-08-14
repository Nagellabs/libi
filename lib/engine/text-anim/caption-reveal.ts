export function activeWordIndexByProgress(words: string[], progress: number): number {
  if (words.length === 0) return -1;
  const p = Math.max(0, Math.min(1, progress));
  return Math.min(words.length - 1, Math.floor(p * words.length));
}
export function currentWordLabel(words: string[], progress: number): string {
  const i = activeWordIndexByProgress(words, progress);
  return i < 0 ? "" : words[i];
}

/**
 * The word-timing reveal math lives in ONE place — `caption-logic.ts` (the
 * dependency-free module also injected into code/three overlay draw functions
 * via DRAW_HELPERS). Re-export the time-based helpers here under the names the
 * renderer already imports so there is a SINGLE implementation (with the shared
 * `KARAOKE_LEAD_S` read-ahead), never two that drift 80ms apart.
 *
 * `activeWordIndexByTime` is `caption-logic.activeWordIndex` (lead-aware). The
 * `CaptionWord` shape ({ text, start, end? }) is a superset of what these need.
 */
export {
  activeWordIndex as activeWordIndexByTime,
  fadeWordsAlphaByTime,
  typewriterRevealedText,
  typewriterVisibleGlyphCount,
} from "./caption-logic";
export type { CaptionWord as TimedWord } from "./caption-logic";

/**
 * Resolve the reveal `fraction` (portion of the element window the discovery
 * animation plays over) for the discovery modes (typewriter / fade-words /
 * slide-up / pop). When `durationMs` is set it WINS: fraction = the reveal's
 * wall-clock duration divided by the element's own duration — so an 800ms
 * typewriter stays 800ms whether the overlay is 2s or 8s. Without it, fall back
 * to the legacy `fraction` (or the full window). Clamped to [0.02, 1] so a
 * pathologically short reveal still advances ≥1 step and never divides by zero.
 * Pure.
 */
export function revealFraction(
  reveal: { fraction?: number; durationMs?: number } | null | undefined,
  elementDurationSec: number,
): number {
  if (!reveal) return 1;
  if (typeof reveal.durationMs === "number" && reveal.durationMs > 0 && elementDurationSec > 0) {
    const f = reveal.durationMs / 1000 / elementDurationSec;
    return Math.max(0.02, Math.min(1, f));
  }
  return reveal.fraction ?? 1;
}
