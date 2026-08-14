// lib/captions/window.ts
import type { CaptionCueWord } from "@/lib/captions/types";

/** A minimal STT word (absolute seconds). Matches ElevenLabsWord structurally. */
export interface AbsoluteWord {
  text: string;
  start: number;
  end: number;
  type?: string;
}

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
 * the window end), so a word straddling the boundary still shows.
 */
export function windowWordsToElementLocal(
  words: AbsoluteWord[],
  startTime: number,
  duration: number,
): CaptionCueWord[] {
  const windowEnd = startTime + Math.max(0, duration);
  const out: CaptionCueWord[] = [];
  for (const w of words) {
    if ((w.type ?? "word") !== "word") continue;
    if (!w.text || !w.text.trim()) continue;
    if (w.end < startTime || w.start > windowEnd) continue;
    out.push({
      text: w.text,
      start: Math.max(0, Number((w.start - startTime).toFixed(3))),
      end: Math.max(0, Number((w.end - startTime).toFixed(3))),
    });
  }
  return out;
}
