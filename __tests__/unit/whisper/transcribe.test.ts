import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  buildWhisperArgs,
  parseWhisperStdout,
  WhisperTranscribeError,
  WHISPER_WITH_SPECS,
  whisperEnvSignature,
} from "@/lib/whisper/transcribe";
import { WHISPER_ENV_SELF_CHECK } from "@/lib/mcp-virtual-deps/whisper-env-dep";
import { hashSpec } from "@/lib/uv-env/hash-spec";
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
      "--with",
      "av>=15,<19",
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
      "--with",
      "av>=15,<19",
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

describe("PyAV pin", () => {
  // faster-whisper 1.1.1 declares `av>=11` with no ceiling and calls
  // `av.open(..., metadata_errors="ignore")`. PyAV 19.0.0 dropped that
  // keyword, so an unpinned env resolved the newest av and EVERY local
  // transcription died with "open() got an unexpected keyword argument
  // 'metadata_errors'" (found 2026-10-02 in the packaged 0.1.18). av 15-18 were
  // measured to transcribe; keep a ceiling below 19 until faster-whisper moves.
  it("bounds av below the release that removed metadata_errors", () => {
    const spec = WHISPER_WITH_SPECS.find((s) => s.startsWith("av"));
    expect(spec).toBeDefined();
    const m = /^av>=(\d+)(?:\.\d+)*,<(\d+)(?:\.\d+)*$/.exec(spec!);
    expect(m, `av spec must be a bounded range, got ${spec}`).not.toBeNull();
    expect(Number(m![2])).toBeLessThanOrEqual(19);
  });

  it("changes the env signature, so a warm env resolved with an unbounded av re-resolves", () => {
    expect(whisperEnvSignature()).not.toEqual(
      // what the signature was before the pin
      hashSpec("3.12", ["faster-whisper==1.1.1", "requests"]),
    );
  });
});

describe("whisper env warm-up probe", () => {
  it("decodes audio through faster-whisper, not just imports it", () => {
    // An import-only probe reported a healthy env while every transcription
    // failed on a PyAV keyword mismatch inside decode_audio.
    expect(WHISPER_ENV_SELF_CHECK).toContain("import faster_whisper");
    expect(WHISPER_ENV_SELF_CHECK).toContain("decode_audio(");
    expect(WHISPER_ENV_SELF_CHECK).toContain("print('ok')");
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
