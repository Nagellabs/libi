import { z } from "zod/v3";

// ──────────────────────────────────────────────────────────────────────────────
// Shared primitives
// ──────────────────────────────────────────────────────────────────────────────

/** Exactly a 4-element tuple of numbers, used for bounding boxes. */
const bbox = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .describe("[x, y, w, h] normalized 0..1, relative to the source video frame");

// ──────────────────────────────────────────────────────────────────────────────
// FrameDescription
// ──────────────────────────────────────────────────────────────────────────────

const personSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).optional(),
  description: z.string().min(1),
  bbox: bbox.optional(),
  pose: z.string().optional(),
  facing: z
    .enum(["camera", "left", "right", "away", "unknown"])
    .optional(),
  visible_parts: z
    .array(z.enum(["face", "torso", "hands", "legs", "feet"]))
    .optional(),
});

const sceneObjectSchema = z.object({
  name: z.string().min(1),
  bbox: bbox.optional(),
  description: z.string().optional(),
});

export const frameDescriptionSchema = z.object({
  schema_version: z.literal("frame_v1"),
  frame_index: z.number().int().nonnegative(),
  timestamp: z.number().nonnegative(),

  scene: z.string().min(1),

  setting: z.object({
    location: z.string().min(1),
    time_of_day: z
      .enum(["day", "evening", "night", "unknown"])
      .optional(),
    lighting: z.string().optional(),
  }),

  people: z.array(personSchema),
  objects: z.array(sceneObjectSchema),

  text_on_screen: z.array(z.string()).optional(),
  camera: z
    .object({
      shot: z
        .enum(["close-up", "medium", "wide", "extreme-wide"])
        .optional(),
      angle: z.enum(["eye-level", "high", "low", "dutch"]).optional(),
      motion: z
        .enum(["static", "pan", "zoom", "shake"])
        .optional(),
    })
    .optional(),
  actions: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),

  custom: z.record(z.unknown()).optional(),
});

export type FrameDescription = z.infer<typeof frameDescriptionSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// VideoSummary
// ──────────────────────────────────────────────────────────────────────────────

const subjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().min(1),
  appearance_frame_indices: z.array(z.number().int().nonnegative()),
  appearance_timestamps: z.array(z.number().nonnegative()),
});

const sectionSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  description: z.string().min(1),
  frame_indices: z.array(z.number().int().nonnegative()),
});

const recurringObjectSchema = z.object({
  name: z.string().min(1),
  count: z.number().int().nonnegative(),
});

export const videoSummarySchema = z.object({
  schema_version: z.literal("video_v1"),
  overview: z.string().min(1),
  duration: z.number().nonnegative(),

  subjects: z.array(subjectSchema),
  sections: z.array(sectionSchema),
  recurring_objects: z.array(recurringObjectSchema),

  visual_style: z.string().optional(),
  audio_summary: z.string().optional(),

  custom: z.record(z.unknown()).optional(),
});

export type VideoSummary = z.infer<typeof videoSummarySchema>;

// ──────────────────────────────────────────────────────────────────────────────
// Transcript (word-level timing)
//
// The shape is a generic word-level STT token: text, a start/end pair, an
// optional token class and an optional speaker. It is deliberately WIDER than
// what any one transcriber emits, because two kinds of producer write it:
//
//   - libi's own path, local Whisper (`lib/whisper/transcribe.ts`), which
//     emits real word tokens only — no spacing, no audio events, no speakers;
//   - a diarizing transcription MCP the user connected themselves, whose
//     results the agent saves through `libi.analysis_save_audio_chunk`
//     (Path B) — libi never calls that provider and cannot constrain it.
//
// So the optional fields are tolerance for the second kind, not a description
// of the first. (Provenance: the enum and the nullable speaker were originally
// taken from ElevenLabs' scribe_v1 response, the transcriber libi itself used
// before local Whisper replaced it — that client is gone, the tolerance is
// not, because Path B still delivers exactly this shape.)
// ──────────────────────────────────────────────────────────────────────────────

export const transcriptWordSchema = z.object({
  text: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  // `audio_event` (laughter, music, …) passes validation and is dropped during
  // sentence aggregation; `spacing` tokens carry timing but no speaker.
  type: z.enum(["word", "spacing", "audio_event"]).optional(),
  // Null, not absent, is what a diarizing producer sends for a single-speaker
  // clip — accept both.
  speaker_id: z.string().nullable().optional(),
});

export const transcriptMetadataSchema = z.object({
  schema_version: z.literal("transcript_v1"),
  provider: z.string().min(1),
  model: z.string().optional(),
  language: z.string().optional(),
  languageProbability: z.number().optional(),
  durationMs: z.number().optional(),
  words: z.array(transcriptWordSchema).min(1),
});

export type TranscriptWord = z.infer<typeof transcriptWordSchema>;
export type TranscriptMetadata = z.infer<typeof transcriptMetadataSchema>;

export interface TranscriptSentence {
  text: string;
  start: number;
  end: number;
  /** Inclusive index range into the original `words` array. */
  wordIndices: [number, number];
  /** Speaker for this sentence — copied from the words. null when not multi-speaker. */
  speakerId: string | null;
}

// ──────────────────────────────────────────────────────────────────────────────
// wordsToSentences heuristics
// ──────────────────────────────────────────────────────────────────────────────

/** Gap (in seconds) between consecutive non-event words above which a sentence is force-split. */
const SENTENCE_PAUSE_THRESHOLD_SECONDS = 1.5;
const TERMINAL_PUNCTUATION_RE = /[.!?]/;

/**
 * Aggregate word-level STT tokens into sentences.
 *
 * Rules (in order):
 *   1. End the current sentence when the most recent token's text contains
 *      sentence-terminal punctuation (`.`, `!`, `?`). Trailing closing
 *      quotes / brackets after the punctuation are still part of the same
 *      sentence — the check is "contains" not "endsWith".
 *   2. Force a split when the gap between two consecutive words exceeds
 *      1.5 seconds (long pause = thought break, even without punctuation).
 *   3. Force a split when speaker_id changes between two consecutive words.
 *   4. Skip `type === "audio_event"` words entirely (they don't belong in
 *      the readable transcript).
 *   5. Drop sentences whose text trims to an empty string.
 *
 * The returned `text` is built by concatenating word.text values in order
 * and trimming. The `wordIndices` range is inclusive and refers to the
 * ORIGINAL word array passed in (not a filtered copy).
 *
 * Pause calculation uses the previous **non-`audio_event`** word as the
 * reference point — not the immediately preceding token.
 *
 * If the input is empty, returns `[]`.
 */
export function wordsToSentences(words: TranscriptWord[]): TranscriptSentence[] {
  if (words.length === 0) return [];

  const sentences: TranscriptSentence[] = [];

  // Indices into the original `words` array for the current sentence buffer.
  let bufferIndices: number[] = [];
  // The last non-audio_event word we appended — used for gap calculation.
  let prevWordIdx: number | null = null;
  // The last non-audio_event, non-spacing word we appended — used for speaker
  // comparison ONLY.  speaker_id is set only on type "word" tokens; spacing
  // tokens carry none.  Comparing against a spacing token's
  // null speaker_id would produce false positives on every spacing token in a
  // real multi-speaker transcript.
  let prevRealWordIdx: number | null = null;

  function flush(): void {
    if (bufferIndices.length === 0) return;

    const texts = bufferIndices.map((i) => words[i].text);
    const text = texts.join("").trim();

    if (text.length > 0) {
      const firstIdx = bufferIndices[0];
      const lastIdx = bufferIndices[bufferIndices.length - 1];
      const speakerId = words[firstIdx].speaker_id ?? null;

      sentences.push({
        text,
        start: words[firstIdx].start,
        end: words[lastIdx].end,
        wordIndices: [firstIdx, lastIdx],
        speakerId,
      });
    }

    bufferIndices = [];
  }

  for (let i = 0; i < words.length; i++) {
    const word = words[i];

    // Rule 4: skip audio_event tokens entirely.
    if (word.type === "audio_event") continue;

    // Determine if we should flush BEFORE adding this word (pre-flush conditions).
    if (bufferIndices.length > 0 && prevWordIdx !== null) {
      const prev = words[prevWordIdx];

      // Rule 2: long pause (uses prevWordIdx — any non-event token for timing).
      const gap = word.start - prev.end;
      if (gap > SENTENCE_PAUSE_THRESHOLD_SECONDS) {
        flush();
      }
      // Rule 3: speaker change — compare against the most recent REAL word
      // token (not spacing).  Spacing tokens carry no speaker_id in real
      // diarized data; using them for comparison would trigger false flushes
      // on every "speaker_0 → null(spacing) → speaker_0" transition.
      else if (
        prevRealWordIdx !== null &&
        word.type !== "spacing" &&
        (word.speaker_id ?? null) !== (words[prevRealWordIdx].speaker_id ?? null)
      ) {
        flush();
      }
    }

    bufferIndices.push(i);
    prevWordIdx = i;
    // Update the real-word pointer only for non-spacing tokens.
    if (word.type !== "spacing") {
      prevRealWordIdx = i;
    }

    // Rule 1: terminal punctuation — flush AFTER adding the word.
    if (TERMINAL_PUNCTUATION_RE.test(word.text)) {
      flush();
    }
  }

  // Flush any remaining words.
  flush();

  return sentences;
}
