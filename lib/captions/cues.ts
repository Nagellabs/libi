// lib/captions/cues.ts
import type { ElevenLabsWord } from "@/lib/elevenlabs/transcribe";
import type { CaptionCue } from "@/lib/captions/types";

export interface BuildCuesOpts {
  /** Approx max characters per line (width budget). Default 32. */
  maxCharsPerLine?: number;
  /** Max lines per cue. Default 2. */
  maxLines?: number;
  /** Lead before first word (s). Default 0.15. */
  lead?: number;
  /** Hold after last word (s). Default 0.4. */
  hold?: number;
}

/** Group spoken words into readable, timed cues. Pure. Ignores non-"word"
 *  tokens (spacing/audio_event). Never overlaps consecutive cues. */
export function buildCaptionCues(words: ElevenLabsWord[], opts: BuildCuesOpts = {}): CaptionCue[] {
  const maxChars = opts.maxCharsPerLine ?? 32;
  const maxLines = opts.maxLines ?? 2;
  const lead = opts.lead ?? 0.15;
  const hold = opts.hold ?? 0.4;
  const budget = maxChars * maxLines;

  const spoken = words.filter((w) => (w.type ?? "word") === "word" && w.text.trim().length > 0);
  const cues: CaptionCue[] = [];
  let buf: ElevenLabsWord[] = [];
  let len = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const text = buf.map((w) => w.text).join(" ").replace(/\s+([,.!?])/g, "$1");
    const start = buf[0].start;
    const end = buf[buf.length - 1].end;
    const cueWords = buf.map((w) => ({ text: w.text, start: w.start, end: w.end }));
    cues.push({ text, start, end, words: cueWords });
    buf = []; len = 0;
  };

  for (const w of spoken) {
    const add = w.text.length + 1;
    if (len + add > budget && buf.length > 0) flush();
    buf.push(w); len += add;
  }
  flush();

  // Apply lead/hold without overlapping the previous cue's post-hold end.
  return cues.map((c, i) => {
    const prevEnd = i > 0 ? cues[i - 1].end + hold : -Infinity;
    return { ...c, start: Math.max(prevEnd, c.start - lead), end: c.end + hold };
  });
}
