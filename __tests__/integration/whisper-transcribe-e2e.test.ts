import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { transcribeAudio, downloadModel } from "@/lib/whisper/transcribe";
import {
  normalize,
  wordErrorRate,
  assertTranscriptShape,
  assertTimingAligned,
} from "@/__tests__/helpers/transcript-compare";

const RUN = process.env.LIBI_WHISPER_E2E === "1";

/**
 * The global test setup (__tests__/setup/isolate-libi-home.ts) forces
 * LIBI_HOME to a throwaway temp dir with no bin/uv and no model — which
 * would make this real E2E fail at resolveUvPath. So this suite installs
 * its OWN persistent LIBI_HOME (cache reused across opt-in runs so the
 * ~hundreds-of-MB faster-whisper wheels + tiny model aren't re-fetched
 * every time) and symlinks a resolvable `uv` into <LIBI_HOME>/bin/.
 */
function resolveSystemUv(): string {
  const bundled = path.join(
    process.env.HOME ?? os.homedir(),
    ".libi",
    "bin",
    "uv",
  );
  if (fs.existsSync(bundled)) return bundled;
  try {
    return execSync("command -v uv", { encoding: "utf-8" }).trim();
  } catch {
    throw new Error(
      "LIBI_WHISPER_E2E=1 but no `uv` found (neither ~/.libi/bin/uv nor on PATH). Install uv or run libi once to bootstrap it.",
    );
  }
}

let prevLibiHome: string | undefined;

beforeAll(() => {
  if (!RUN) return;
  prevLibiHome = process.env.LIBI_HOME;
  const home = path.join(os.tmpdir(), "libi-whisper-e2e");
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  const uvLink = path.join(home, "bin", "uv");
  try {
    fs.unlinkSync(uvLink);
  } catch {
    /* not present */
  }
  fs.symlinkSync(resolveSystemUv(), uvLink);
  process.env.LIBI_HOME = home;
});

afterAll(() => {
  if (!RUN) return;
  if (prevLibiHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = prevLibiHome;
});

if (!RUN)
  console.info(
    "[skip] real faster-whisper E2E — set LIBI_WHISPER_E2E=1 to run (downloads the faster-whisper wheels + tiny model)",
  );

describe.skipIf(!RUN)("real faster-whisper E2E (tiny)", () => {
  it("transcribes jfk.wav within tolerance of the ElevenLabs golden", async () => {
    const expected = JSON.parse(
      fs.readFileSync(
        path.resolve("__tests__/fixtures/whisper/jfk.expected.json"),
        "utf-8",
      ),
    );
    await downloadModel("tiny");
    const r = await transcribeAudio({
      audioPath: path.resolve("__tests__/fixtures/audio/jfk.wav"),
      model: "tiny",
    });
    expect(
      wordErrorRate(normalize(r.text), expected.normalizedText),
    ).toBeLessThanOrEqual(expected.maxWER);
    for (const phrase of expected.keyPhrases) {
      expect(normalize(r.text)).toContain(phrase);
    }
    assertTranscriptShape(r.words, expected.maxDurationSeconds);
    expect(r.words.length).toBeGreaterThanOrEqual(expected.minWords);
    assertTimingAligned(r.words, expected.refWords, {
      medianMs: 400,
      p95Ms: 900,
    });
  }, 600_000);
});
