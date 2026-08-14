/** Pure timing logic for the word-driven caption styles.
 *
 *  These run INSIDE the generated draw-function bodies (they are injected via
 *  DRAW_HELPERS), so they must stay dependency-free. They are unit-tested
 *  directly — that is where the caption sync correctness is verified, rather
 *  than by parsing rendered pixels.
 *
 *  All `t` and `word.start` values are ELEMENT-LOCAL seconds (relative to the
 *  caption overlay's startTime). */

export interface CaptionWord {
  text: string;
  start: number;
  end?: number;
}

/**
 * Cumulative style: every word whose `start <= t`, joined by spaces. Returns
 * `""` before the first word begins. Words never disappear once shown — the
 * sentence builds up and holds.
 */
export function cumulativeLabel(words: CaptionWord[], t: number): string {
  const shown: string[] = [];
  for (const w of words) {
    if (t >= w.start) shown.push(w.text);
  }
  return shown.join(" ");
}

/**
 * Word-by-word style: the single most-recently-started word (`start <= t`).
 * Returns `null` before the first word. No gaps — the current word stays until
 * the next word starts.
 */
export function currentWord(words: CaptionWord[], t: number): string | null {
  let cur: string | null = null;
  for (const w of words) {
    if (t >= w.start) cur = w.text;
  }
  return cur;
}

/** Seconds the karaoke highlight "reads ahead" of the spoken word — the
 *  Opus-Clip trick: the active word lights up ~80ms BEFORE its audio onset so
 *  the eye is already on it when the sound arrives, which reads as tighter sync. */
export const KARAOKE_LEAD_S = 0.08;

/**
 * Karaoke style: index of the most-recently-started word (`start <= t`), or
 * `-1` before the first word. The full sentence is always shown; this index
 * is which word to emphasize.
 *
 * The lookup is evaluated at `t + KARAOKE_LEAD_S` so the highlight leads the
 * spoken word by ~80ms (see `KARAOKE_LEAD_S`).
 */
export function activeWordIndex(words: CaptionWord[], t: number): number {
  const tt = t + KARAOKE_LEAD_S;
  let idx = -1;
  for (let i = 0; i < words.length; i++) {
    if (tt >= words[i].start) idx = i;
  }
  return idx;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Collapse the space BEFORE ,.!? so a caption string reconstructed from words
 *  matches the `content` that `buildCaptionCues` stored (which applies the same
 *  collapse). Keeps the typewriter's revealed substring byte-aligned with the
 *  overlay's content. */
function collapsePunct(s: string): string {
  return s.replace(/\s+([,.!?])/g, "$1");
}

/**
 * Per-word LETTER reveal (voice-synced typewriter): every fully-spoken word in
 * full, plus the in-progress word truncated to the fraction of its OWN
 * [start,end] window elapsed at `t`. Words not yet started contribute nothing —
 * so the caret sits on the word actually being spoken instead of marching at a
 * constant rate across the cue. Evaluated at `t + KARAOKE_LEAD_S` for the same
 * read-ahead as the karaoke highlight. Returns the visible substring of the
 * caption (punctuation-collapsed to match the overlay's `content`). Pure;
 * assumes ascending `start`.
 */
export function typewriterRevealedText(words: CaptionWord[], t: number): string {
  const tt = t + KARAOKE_LEAD_S;
  const parts: string[] = [];
  for (const w of words) {
    const end = w.end ?? w.start;
    if (tt >= end) {
      parts.push(w.text);
      continue;
    }
    if (tt > w.start) {
      const dur = end - w.start;
      const frac = dur > 0 ? clamp01((tt - w.start) / dur) : 1;
      const n = Math.max(0, Math.floor(w.text.length * frac));
      if (n > 0) parts.push(w.text.slice(0, n));
    }
    break; // this word is the frontier — nothing after it has started
  }
  return collapsePunct(parts.join(" "));
}

/** Non-space glyph count of the voice-synced typewriter reveal at `t`. The 3D
 *  text path toggles per-GLYPH visibility (`glyphIndex < n`), so it needs a
 *  count rather than the string. Same word timing as `typewriterRevealedText`. */
export function typewriterVisibleGlyphCount(words: CaptionWord[], t: number): number {
  return typewriterRevealedText(words, t).replace(/\s+/g, "").length;
}

/**
 * Per-word fade alpha (0..1) from real per-word timings: each word ramps 0→1
 * over `rampSec` starting at its own `start`, evaluated at `t + KARAOKE_LEAD_S`
 * (same read-ahead as the karaoke highlight). The time-synced analogue of the
 * linear `fadeWordsAlpha`. Words not yet reached read 0; a fully-elapsed word
 * reads 1. Pure.
 */
export function fadeWordsAlphaByTime(words: CaptionWord[], t: number, rampSec = 0.18): number[] {
  const tt = t + KARAOKE_LEAD_S;
  const ramp = rampSec > 0 ? rampSec : 0.001;
  return words.map((w) => {
    if (tt <= w.start) return 0;
    return clamp01((tt - w.start) / ramp);
  });
}
