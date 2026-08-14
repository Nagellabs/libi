import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { synthesizeSpeech, downloadModel } from "@/lib/tts/synthesize";
import {
  downloadModel as whisperDownload,
  transcribeAudio,
} from "@/lib/whisper/transcribe";
import { assertWav } from "@/__tests__/helpers/audio-assert";
import {
  normalize,
  wordErrorRate,
} from "@/__tests__/helpers/transcript-compare";

const RUN = process.env.LIBI_TTS_E2E === "1";

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
      "LIBI_TTS_E2E=1 but no `uv` found (neither ~/.libi/bin/uv nor on PATH).",
    );
  }
}

let prevLibiHome: string | undefined;

beforeAll(() => {
  if (!RUN) return;
  prevLibiHome = process.env.LIBI_HOME;
  const home = path.join(os.tmpdir(), "libi-tts-e2e");
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

describe.skipIf(!RUN)("real Kokoro TTS E2E (round-trip via Whisper)", () => {
  it("synthesizes intelligible speech of the requested text", async () => {
    const expected = JSON.parse(
      fs.readFileSync(
        path.resolve("__tests__/fixtures/tts/expected.json"),
        "utf-8",
      ),
    );

    await downloadModel();
    const r = await synthesizeSpeech({
      text: expected.text,
      voice: expected.voice,
      withTimestamps: true,
    });

    // Audio sanity.
    const wav = fs.readFileSync(r.wavPath);
    assertWav(wav, {
      sampleRate: expected.sampleRate,
      minSeconds: expected.minSeconds,
      maxSeconds: expected.maxSeconds,
    });
    expect(r.words.length).toBeGreaterThan(3);
    let prev = -1;
    for (const w of r.words) {
      expect(w.start).toBeGreaterThanOrEqual(0);
      expect(w.end).toBeGreaterThanOrEqual(w.start);
      expect(w.end).toBeLessThanOrEqual(r.durationSeconds + 0.01);
      expect(w.start).toBeGreaterThanOrEqual(prev - 0.001);
      prev = w.start;
    }

    // Round-trip oracle: speak → transcribe with the local Whisper tiny
    // model → the words must come back.
    await whisperDownload("tiny");
    const stt = await transcribeAudio({ audioPath: r.wavPath, model: "tiny" });
    const wer = wordErrorRate(normalize(stt.text), normalize(expected.text));
    expect(wer).toBeLessThanOrEqual(expected.maxRoundTripWER);

    fs.rmSync(r.wavPath, { force: true });
  }, 1_200_000);
});
