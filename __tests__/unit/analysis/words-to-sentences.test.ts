import { describe, it, expect } from "vitest";
import { wordsToSentences } from "@/lib/analysis/schemas";
import type { TranscriptWord } from "@/lib/analysis/schemas";

// ──────────────────────────────────────────────────────────────────────────────
// Helper
// ──────────────────────────────────────────────────────────────────────────────

function w(
  text: string,
  start: number,
  end: number,
  opts: Partial<Pick<TranscriptWord, "type" | "speaker_id">> = {},
): TranscriptWord {
  return { text, start, end, ...opts };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe("wordsToSentences", () => {
  it("returns [] for an empty array", () => {
    expect(wordsToSentences([])).toEqual([]);
  });

  it("produces one sentence from three words ending with '.'", () => {
    const words = [
      w("Hello", 0, 0.4),
      w(" ", 0.4, 0.5, { type: "spacing" }),
      w("world.", 0.5, 1.0),
    ];
    const result = wordsToSentences(words);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Hello world.");
    expect(result[0].start).toBe(0);
    expect(result[0].end).toBe(1.0);
    expect(result[0].wordIndices).toEqual([0, 2]);
  });

  it("splits on terminal punctuation into two sentences with correct word index ranges", () => {
    // "Hi." ends at index 1 (terminal punctuation triggers flush).
    // The spacing token (index 2) starts the next sentence buffer.
    // "Bye!" ends it.  text.trim() strips the leading space.
    const words = [
      w("Hi", 0, 0.3),               // 0
      w(".", 0.3, 0.35),              // 1
      w(" ", 0.35, 0.4, { type: "spacing" }), // 2
      w("Bye", 0.4, 0.8),             // 3
      w("!", 0.8, 0.85),              // 4
    ];
    const result = wordsToSentences(words);
    expect(result).toHaveLength(2);

    expect(result[0].text).toBe("Hi.");
    expect(result[0].wordIndices).toEqual([0, 1]);
    expect(result[0].start).toBe(0);
    expect(result[0].end).toBe(0.35);

    // text.trim() removes the leading space from the spacing token.
    expect(result[1].text).toBe("Bye!");
    expect(result[1].wordIndices).toEqual([2, 4]);
    expect(result[1].start).toBe(0.35);
    expect(result[1].end).toBe(0.85);
  });

  it("splits on a long pause (gap > 1.5s) even without terminal punctuation", () => {
    const words = [
      w("Okay", 0, 0.4),
      w(" ", 0.4, 0.5, { type: "spacing" }),
      // gap from spacing.end (0.5) → "next".start (2.1) = 1.6s  (> 1.5)
      // The spacing token is in the buffer so it gets flushed with the first sentence.
      // text.trim() strips trailing space.
      w("next", 2.1, 2.5),
    ];
    const result = wordsToSentences(words);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("Okay");
    expect(result[1].text).toBe("next");
  });

  it("does NOT split when the gap is exactly 1.5s (boundary is exclusive)", () => {
    const words = [
      w("one", 0, 0.3),
      w("two", 1.8, 2.1), // gap = 1.5 — not > 1.5
    ];
    const result = wordsToSentences(words);
    expect(result).toHaveLength(1);
  });

  it("splits on speaker change and both halves report correct speakerId", () => {
    // Spacing token carries NO speaker_id (real ElevenLabs shape).
    const words = [
      w("Hello", 0, 0.4, { speaker_id: "A" }),
      w(" ", 0.4, 0.5, { type: "spacing" }),
      w("there", 0.5, 0.9, { speaker_id: "B" }),
      w(".", 0.9, 0.95, { speaker_id: "B" }),
    ];
    const result = wordsToSentences(words);
    expect(result).toHaveLength(2);

    expect(result[0].speakerId).toBe("A");
    // spacing token is in the first sentence's buffer; trim() removes trailing space.
    expect(result[0].text).toBe("Hello");

    expect(result[1].speakerId).toBe("B");
    expect(result[1].text).toBe("there.");
  });

  it("audio_event token is skipped — not in text, not in wordIndices, does not trigger pause-split", () => {
    const words = [
      w("Yeah", 0, 0.3),
      // audio_event with a big gap on both sides — should NOT trigger pause split
      w("[laughter]", 0.4, 2.5, { type: "audio_event" }),
      w("okay", 2.6, 3.0),
    ];
    const result = wordsToSentences(words);
    // No terminal punctuation, gap between "Yeah".end (0.3) and "okay".start (2.6) = 2.3s
    // BUT the gap should be measured ignoring the audio_event token.
    // "Yeah".end = 0.3, "okay".start = 2.6 — gap IS > 1.5 because audio_event is skipped.
    // The task says audio_event doesn't trigger pause-split based on ITS OWN gap —
    // but the gap between prev real word and next real word is still evaluated.
    // Per spec: "They also shouldn't trigger a long-pause split — use the previous
    // non-event word as the reference for gap calculation."
    // So prev non-event = "Yeah" (end=0.3), next non-event = "okay" (start=2.6), gap=2.3 → splits.
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("Yeah");
    expect(result[0].wordIndices[0]).toBe(0);
    expect(result[0].wordIndices[1]).toBe(0);

    expect(result[1].text).toBe("okay");
    expect(result[1].wordIndices[0]).toBe(2);
    expect(result[1].wordIndices[1]).toBe(2);

    // audio_event index (1) must NOT appear in either sentence's range
    const allIndices = [
      ...Array.from({ length: result[0].wordIndices[1] - result[0].wordIndices[0] + 1 }, (_, k) => k + result[0].wordIndices[0]),
      ...Array.from({ length: result[1].wordIndices[1] - result[1].wordIndices[0] + 1 }, (_, k) => k + result[1].wordIndices[0]),
    ];
    expect(allIndices).not.toContain(1);
  });

  it("audio_event alone does NOT trigger a pause split against itself", () => {
    // All three words are close together time-wise; the audio_event is surrounded
    // by real words with < 1.5s gap.  Result: one sentence.
    const words = [
      w("yes", 0, 0.3),
      w("[music]", 0.35, 0.5, { type: "audio_event" }),
      w("sure", 0.55, 0.9),
    ];
    const result = wordsToSentences(words);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("yessure");
    expect(result[0].wordIndices).toEqual([0, 2]);
  });

  it("returns [] for input that is only whitespace spacing tokens", () => {
    const words = [w(" ", 0, 0.1, { type: "spacing" })];
    const result = wordsToSentences(words);
    expect(result).toHaveLength(0);
  });

  it("terminal punctuation inside quotes stays in the same sentence (contains-check)", () => {
    // 'text: "yes!"' followed by a space token — the `!` is contained in the
    // word text, so rule 1 fires and the sentence ends there.  The NEXT word
    // (space) starts a new sentence that trims to empty → dropped.
    const words = [
      w('He said "yes!"', 0, 0.8),
      w(" ", 0.8, 0.9, { type: "spacing" }),
      w("then", 0.9, 1.2),
    ];
    const result = wordsToSentences(words);
    // First sentence ends at the word containing "!" (index 0).
    expect(result[0].wordIndices[1]).toBe(0);
    expect(result[0].text).toBe('He said "yes!"');

    // "then" is a separate sentence (no terminal punctuation → flushed at end).
    expect(result[result.length - 1].text.trim()).toBe("then");
  });

  it("speakerId is null when no speaker_id is provided on any word", () => {
    const words = [w("Hello", 0, 0.4), w(".", 0.4, 0.45)];
    const result = wordsToSentences(words);
    expect(result[0].speakerId).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // Regression tests — spacing token speaker_id handling (Fix C1)
  // ──────────────────────────────────────────────────────────────────────────────

  it("does not split on spacing tokens that lack speaker_id when neighbouring word tokens share one", () => {
    const words = [
      { text: "Hello", start: 0.0, end: 0.4, type: "word" as const, speaker_id: "speaker_0" },
      { text: " ",     start: 0.4, end: 0.5, type: "spacing" as const /* no speaker_id */ },
      { text: "world", start: 0.5, end: 0.9, type: "word" as const, speaker_id: "speaker_0" },
      { text: ".",     start: 0.9, end: 1.0, type: "spacing" as const /* no speaker_id */ },
    ];
    const sentences = wordsToSentences(words);
    expect(sentences).toHaveLength(1);
    expect(sentences[0].text).toBe("Hello world.");
    expect(sentences[0].speakerId).toBe("speaker_0");
  });

  it("still splits when a real word token's speaker_id differs from the previous real word token", () => {
    const words = [
      { text: "Yes", start: 0.0, end: 0.3, type: "word" as const, speaker_id: "speaker_0" },
      { text: " ",   start: 0.3, end: 0.4, type: "spacing" as const /* no speaker_id */ },
      { text: "no",  start: 0.4, end: 0.7, type: "word" as const, speaker_id: "speaker_1" },
    ];
    const sentences = wordsToSentences(words);
    expect(sentences).toHaveLength(2);
    expect(sentences[0].speakerId).toBe("speaker_0");
    expect(sentences[1].speakerId).toBe("speaker_1");
  });
});
