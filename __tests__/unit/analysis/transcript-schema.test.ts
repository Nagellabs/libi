import { describe, it, expect } from "vitest";
import {
  transcriptWordSchema,
  transcriptMetadataSchema,
} from "@/lib/analysis/schemas";

// ──────────────────────────────────────────────────────────────────────────────
// transcriptWordSchema
// ──────────────────────────────────────────────────────────────────────────────

describe("transcriptWordSchema", () => {
  it("parses a minimal word", () => {
    expect(transcriptWordSchema.safeParse({ text: "hello", start: 0, end: 0.5 }).success).toBe(true);
  });

  it("parses a word with all optional fields", () => {
    expect(
      transcriptWordSchema.safeParse({
        text: "hello",
        start: 1.0,
        end: 1.4,
        type: "word",
        speaker_id: "speaker_0",
      }).success,
    ).toBe(true);
  });

  it("parses speaker_id: null", () => {
    expect(
      transcriptWordSchema.safeParse({ text: "hi", start: 0, end: 0.3, speaker_id: null }).success,
    ).toBe(true);
  });

  it("parses type: audio_event", () => {
    expect(
      transcriptWordSchema.safeParse({ text: "[laughter]", start: 2.0, end: 2.5, type: "audio_event" }).success,
    ).toBe(true);
  });

  it("fails when start is negative", () => {
    expect(
      transcriptWordSchema.safeParse({ text: "hi", start: -0.1, end: 0.3 }).success,
    ).toBe(false);
  });

  it("fails for unknown type value", () => {
    expect(
      transcriptWordSchema.safeParse({ text: "hi", start: 0, end: 0.3, type: "punctuation" }).success,
    ).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// transcriptMetadataSchema
// ──────────────────────────────────────────────────────────────────────────────

const minimalWord = { text: "hi", start: 0, end: 0.3 };

describe("transcriptMetadataSchema", () => {
  it("parses a valid full payload", () => {
    const result = transcriptMetadataSchema.safeParse({
      schema_version: "transcript_v1",
      provider: "elevenlabs",
      model: "scribe_v1",
      language: "en",
      languageProbability: 0.99,
      durationMs: 5000,
      words: [
        { text: "Hello", start: 0, end: 0.5, type: "word", speaker_id: "speaker_0" },
        { text: " ", start: 0.5, end: 0.6, type: "spacing" },
        { text: "world", start: 0.6, end: 1.0, type: "word", speaker_id: "speaker_0" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("parses the minimum required payload", () => {
    const result = transcriptMetadataSchema.safeParse({
      schema_version: "transcript_v1",
      provider: "elevenlabs",
      words: [minimalWord],
    });
    expect(result.success).toBe(true);
  });

  it("fails when words is missing", () => {
    const result = transcriptMetadataSchema.safeParse({
      schema_version: "transcript_v1",
      provider: "elevenlabs",
    });
    expect(result.success).toBe(false);
  });

  it("fails when words is an empty array", () => {
    const result = transcriptMetadataSchema.safeParse({
      schema_version: "transcript_v1",
      provider: "elevenlabs",
      words: [],
    });
    expect(result.success).toBe(false);
  });

  it("fails when schema_version is not the literal 'transcript_v1'", () => {
    const result = transcriptMetadataSchema.safeParse({
      schema_version: "v2",
      provider: "elevenlabs",
      words: [minimalWord],
    });
    expect(result.success).toBe(false);
  });

  it("fails when a word has a negative start", () => {
    const result = transcriptMetadataSchema.safeParse({
      schema_version: "transcript_v1",
      provider: "elevenlabs",
      words: [{ text: "hi", start: -1, end: 0.3 }],
    });
    expect(result.success).toBe(false);
  });

  it("parses a word with speaker_id: null inside a full payload", () => {
    const result = transcriptMetadataSchema.safeParse({
      schema_version: "transcript_v1",
      provider: "elevenlabs",
      words: [{ text: "hi", start: 0, end: 0.3, speaker_id: null }],
    });
    expect(result.success).toBe(true);
  });

  it("parses a word with type: audio_event inside a full payload", () => {
    const result = transcriptMetadataSchema.safeParse({
      schema_version: "transcript_v1",
      provider: "elevenlabs",
      words: [{ text: "[music]", start: 0, end: 2.0, type: "audio_event" }],
    });
    expect(result.success).toBe(true);
  });
});
