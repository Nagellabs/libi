// lib/captions/window.ts
import type { CaptionCueWord } from "@/lib/captions/types";

/** A minimal STT word (absolute seconds). Matches SttWord structurally. */
export interface AbsoluteWord {
  text: string;
  start: number;
  end: number;
  type?: string;
}

/** Slack for a boundary set from a word's own time (timeline seconds are a
 *  float sum, so `0.7 + 2` may land a hair off the `2.7` an agent passes). */
const BOUNDARY_EPS = 1e-6;

/**
 * Take absolute-time STT words and return those overlapping an overlay's
 * `[startTime, startTime + duration]` window, converted to ELEMENT-LOCAL seconds
 * (relative to `startTime`, clamped ≥0). This is how a CUSTOM code/three caption
 * overlay gets the SAME voice-synced snapshot the built-in text reveals use: the
 * transcript is the source of truth, `overlay.caption.words` is the derived
 * snapshot, and nothing is hand-embedded in a code body. Pure.
 *
 * Non-"word" tokens (spacing/audio_event) and blank text are dropped. A word is
 * kept when it overlaps the window at all (its end ≥ startTime AND its start ≤
 * the window end), so a word straddling the boundary still shows — right for a
 * free-form code/three caption. `byStart` instead keeps a word whose START is in
 * the half-open `[startTime, startTime + duration)`: right for a TEXT cue, whose
 * `caption.words[i]` must pair with its i-th content token.
 */
export function windowWordsToElementLocal(
  words: AbsoluteWord[],
  startTime: number,
  duration: number,
  opts: { byStart?: boolean } = {},
): CaptionCueWord[] {
  const windowEnd = startTime + Math.max(0, duration);
  const out: CaptionCueWord[] = [];
  for (const w of words) {
    if ((w.type ?? "word") !== "word") continue;
    if (!w.text || !w.text.trim()) continue;
    if (opts.byStart) {
      // A TEXT cue owns a word by where it STARTS, in the half-open
      // [startTime, windowEnd) — the way generate_captions' cues split. Whisper's
      // words are contiguous (end === next start), so the inclusive overlap
      // below would hand a cue its neighbour's word at a shared boundary.
      if (w.start < startTime - BOUNDARY_EPS || w.start >= windowEnd - BOUNDARY_EPS) continue;
    } else if (w.end < startTime || w.start > windowEnd) continue;
    out.push({
      text: w.text,
      start: Math.max(0, Number((w.start - startTime).toFixed(3))),
      end: Math.max(0, Number((w.end - startTime).toFixed(3))),
    });
  }
  return out;
}

/** A token that is a spoken word: it holds a letter or a digit. */
function isSpokenToken(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function normalizeWord(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * The words a TEXT cue actually says, out of the words heard in its window.
 * A cue's window can hold more words than its text (a lead-in before the first
 * word, a hold past the next word's start); karaoke pairs `caption.words[i]`
 * with the i-th content token, so an extra word shifts the highlight for the
 * whole cue. When the window has MORE words than the text has spoken tokens,
 * keep the contiguous run that best matches the text (most equal words,
 * case/punctuation-insensitive; the earliest on a tie). Otherwise the words are
 * returned unchanged — the caller re-keys them to the tokens. Pure.
 */
export function wordsSaidByText(words: CaptionCueWord[], content: string): CaptionCueWord[] {
  const spoken = content
    .split(/\s+/)
    .filter((t) => t.length > 0 && isSpokenToken(t))
    .map(normalizeWord);
  const n = spoken.length;
  if (n === 0 || words.length <= n) return words;
  const heard = words.map((w) => normalizeWord(w.text));
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i + n <= words.length; i++) {
    let score = 0;
    for (let j = 0; j < n; j++) if (heard[i + j] === spoken[j]) score++;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return words.slice(best, best + n);
}
