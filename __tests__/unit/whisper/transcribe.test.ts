import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  buildWhisperArgs,
  parseWhisperStdout,
  WhisperTranscribeError,
} from "@/lib/whisper/transcribe";
import { assertTranscriptShape } from "@/__tests__/helpers/transcript-compare";

const fwOut = JSON.parse(
  fs.readFileSync(
    path.resolve("__tests__/fixtures/whisper/jfk.fw-output.json"),
    "utf-8",
  ),
);
const expected = JSON.parse(
  fs.readFileSync(
    path.resolve("__tests__/fixtures/whisper/jfk.expected.json"),
    "utf-8",
  ),
);

describe("buildWhisperArgs", () => {
  it("constructs the uv run argv for transcription", () => {
    expect(
      buildWhisperArgs({
        scriptPath: "/repo/mcp/whisper/transcribe.py",
        audioPath: "/tmp/a.wav",
        model: "small",
        downloadRoot: "/home/.libi/models/whisper",
      }),
    ).toEqual([
      "run",
      "--python",
      "3.12",
      "--with",
      "faster-whisper==1.1.1",
      "--with",
      "requests",
      "python",
      "/repo/mcp/whisper/transcribe.py",
      "/tmp/a.wav",
      "--model",
      "small",
      "--download-root",
      "/home/.libi/models/whisper",
    ]);
  });

  it("constructs the download-only argv", () => {
    expect(
      buildWhisperArgs({
        scriptPath: "/repo/mcp/whisper/transcribe.py",
        model: "medium",
        downloadRoot: "/d",
        downloadOnly: true,
      }),
    ).toEqual([
      "run",
      "--python",
      "3.12",
      "--with",
      "faster-whisper==1.1.1",
      "--with",
      "requests",
      "python",
      "/repo/mcp/whisper/transcribe.py",
      "--model",
      "medium",
      "--download-root",
      "/d",
      "--download-only",
    ]);
  });
});

describe("parseWhisperStdout", () => {
  // Layer-1 validates PARSE CORRECTNESS + STRUCTURAL SHAPE only. The fixture
  // is a shape-faithful stand-in derived from the ElevenLabs reference, so a
  // WER / timing comparison against that same reference would be tautological.
  // Real-accuracy and timing fidelity are validated by the gated Layer-2 E2E
  // (whisper-transcribe-e2e.test.ts), which runs faster-whisper for real.
  it("parses whisper-shaped JSON into the ElevenLabs contract", () => {
    const r = parseWhisperStdout(JSON.stringify(fwOut));
    expect(typeof r.text).toBe("string");
    expect(r.text.length).toBeGreaterThan(0);
    expect(Array.isArray(r.words)).toBe(true);
    expect(r.words.length).toBeGreaterThanOrEqual(expected.minWords);
    expect(r.language_code).toBe(fwOut.language_code);
    // Every word is faster-whisper shaped: type "word", speaker_id null,
    // monotonic, in-range — assertTranscriptShape enforces all of this.
    assertTranscriptShape(r.words, expected.maxDurationSeconds);
  });

  it("throws WhisperTranscribeError on empty / malformed / missing text", () => {
    expect(() => parseWhisperStdout("")).toThrow(WhisperTranscribeError);
    expect(() => parseWhisperStdout("not json")).toThrow(
      WhisperTranscribeError,
    );
    expect(() => parseWhisperStdout(JSON.stringify({ words: [] }))).toThrow(
      WhisperTranscribeError,
    );
  });
});
