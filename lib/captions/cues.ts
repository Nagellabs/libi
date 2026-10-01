// lib/captions/cues.ts
import type { SttWord } from "@/lib/analysis/types";
import type { CaptionCue } from "@/lib/captions/types";

export interface BuildCuesOpts {
  /** Approx max characters per line (width budget). Default 32 — callers
   *  that know the canvas pass `captionCharsPerLine`. */
  maxCharsPerLine?: number;
  /** Max lines per cue. Default 2. */
  maxLines?: number;
  /** Lead before first word (s). Default 0.15. */
  lead?: number;
  /** Hold after last word (s). Default 0.4. */
  hold?: number;
  /** Hard end-of-timeline clamp (s), in the SAME clock as the input words'
   *  `start`/`end`. No cue's held end may exceed it. A cue whose first word
   *  starts before it is kept (clamped to end at it); only a cue whose first
   *  word starts at/after it is dropped. Omit for no clamp. */
  maxEnd?: number;
  /** Floor for the lead-in / first cue start (s), in the SAME clock as the
   *  input words' `start`/`end` (and as `maxEnd`). Default 0. Pass the
   *  transcribed video overlay's own timeline `startTime` when the caller has
   *  already shifted the words onto the piece's timeline, so a cue can't
   *  lead-in before that overlay begins. */
  minStart?: number;
}

/** The no-wrap character budget for one caption line on a canvas `frameWidth`
 *  px wide at `fontSize` px: an average glyph is ~0.6 em, and a line may use
 *  84% of the width (inside the renderer's 90% wrap width, with slack for wide
 *  glyphs). Clamped to 12..42 — narrower is unreadable churn, wider is a line
 *  too long to read at a glance. 1080 wide at 90 px → 16; 1920 at 59 px → 42. */
export function captionCharsPerLine(frameWidth: number, fontSize: number): number {
  const raw = Math.floor((0.84 * frameWidth) / (0.6 * fontSize));
  return Math.min(42, Math.max(12, raw));
}

/** Group spoken words into readable, timed cues. Pure. Ignores non-"word"
 *  tokens (spacing/audio_event). Never overlaps consecutive cues. */
export function buildCaptionCues(words: SttWord[], opts: BuildCuesOpts = {}): CaptionCue[] {
  const maxChars = opts.maxCharsPerLine ?? 32;
  const maxLines = opts.maxLines ?? 2;
  const lead = opts.lead ?? 0.15;
  const hold = opts.hold ?? 0.4;
  const maxEnd = opts.maxEnd;
  const minStart = opts.minStart ?? 0;
  const budget = maxChars * maxLines;

  const spoken = words.filter((w) => (w.type ?? "word") === "word" && w.text.trim().length > 0);
  const cues: CaptionCue[] = [];
  let buf: SttWord[] = [];
  let len = 0;

  const flush = () => {
    if (buf.length === 0) return;
    // Trim each word first: some STT backends (whisper.cpp) prepend a space
    // to every non-first token, which without trimming leaks into a leading
    // space on the cue's own text and a doubled space between words.
    const text = buf
      .map((w) => w.text.trim())
      .filter((t) => t.length > 0)
      .join(" ")
      .replace(/\s+([,.!?])/g, "$1");
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

  // Apply lead/hold. The hold must never DELAY the next cue (QA 2026-09-19
  // D1/D3): each cue starts at max(its first word - lead, minStart, the
  // previous cue's LAST WORD end) — never at the previous cue's HELD end —
  // and each cue's held end is then clamped to the next cue's start (which
  // is never before its own last word end), so cues stay non-overlapping and
  // every word is on screen, highlighted, when it is spoken.
  //
  // When `maxEnd` is given, a cue whose first word starts before it is always
  // kept, its end clamped to maxEnd (a cue straddling maxEnd ends exactly
  // there); only cues whose first word starts at/after maxEnd are dropped.
  const kept = maxEnd == null ? cues : cues.filter((c) => c.start < maxEnd);
  const starts = kept.map((c, i) =>
    Math.max(minStart, c.start - lead, i > 0 ? kept[i - 1].end : Number.NEGATIVE_INFINITY),
  );
  const out: CaptionCue[] = [];
  kept.forEach((c, i) => {
    const start = starts[i];
    if (maxEnd != null && start >= maxEnd) return; // degenerate (overlapping STT words): no room left
    let end = c.end + hold;
    if (i + 1 < kept.length) end = Math.min(end, starts[i + 1]);
    if (maxEnd != null) end = Math.min(end, maxEnd);
    end = Math.max(end, start);
    out.push({ ...c, start, end });
  });
  return out;
}
