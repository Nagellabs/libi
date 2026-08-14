/**
 * One-time golden generator. Dev-run only, NEVER in CI.
 * Run from the worktree with the main repo's env file:
 *
 *   npx tsx --env-file=/abs/path/to/libi/.env.local \
 *     scripts/gen-transcript-golden.ts
 *
 * Produces three committed files under __tests__/fixtures/whisper/.
 * The key is read from process.env only — never printed, never written.
 */
import fs from "fs";
import path from "path";
import { transcribeAudio } from "@/lib/elevenlabs/transcribe";

async function main() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new Error(
      "ELEVENLABS_API_KEY not in env. Run with: npx tsx --env-file=<libi>/.env.local scripts/gen-transcript-golden.ts",
    );
  }
  const audioPath = path.resolve("__tests__/fixtures/audio/jfk.wav");
  const outDir = path.resolve("__tests__/fixtures/whisper");
  fs.mkdirSync(outDir, { recursive: true });

  const ref = await transcribeAudio({ audioPath, apiKey: key });

  // 1. raw ElevenLabs reference
  fs.writeFileSync(
    path.join(outDir, "jfk.elevenlabs.json"),
    JSON.stringify(ref, null, 2) + "\n",
  );

  // faster-whisper emits real word tokens only — no "spacing"/"audio_event".
  // Derive the comparison set from ElevenLabs' word tokens so refWords /
  // minWords / the fw-shaped mock are faithful to what Whisper produces.
  const wordEntries = ref.words.filter(
    (w) => w.type === undefined || w.type === "word",
  );
  const refWords = wordEntries.map((w) => ({
    text: w.text,
    start: w.start,
    end: w.end,
  }));
  const lastEnd = ref.words.reduce((m, w) => Math.max(m, w.end ?? 0), 0);
  const norm = ref.text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  // 2. assertion contract
  const expected = {
    normalizedText: norm,
    keyPhrases: ["ask not what your country", "do for your country"],
    minWords: Math.floor(ref.words.length * 0.85),
    maxDurationSeconds: Math.ceil(lastEnd + 1),
    maxWER: 0.25,
    refWords,
  };
  fs.writeFileSync(
    path.join(outDir, "jfk.expected.json"),
    JSON.stringify(expected, null, 2) + "\n",
  );

  // 3. whisper-shaped mock stdout (Layer-1 input): word tokens only,
  // re-tagged exactly as faster-whisper would emit them. This is a
  // shape-faithful stand-in for parse/shape testing; real-accuracy and
  // timing fidelity are validated by the gated Layer-2 E2E, not Layer-1.
  const fwShaped = {
    language_code: ref.language_code,
    language_probability: ref.language_probability,
    text: ref.text,
    words: wordEntries.map((w) => ({
      text: w.text,
      start: w.start,
      end: w.end,
      type: "word" as const,
      speaker_id: null,
    })),
  };
  fs.writeFileSync(
    path.join(outDir, "jfk.fw-output.json"),
    JSON.stringify(fwShaped, null, 2) + "\n",
  );

  console.log("Wrote 3 golden files to", outDir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
