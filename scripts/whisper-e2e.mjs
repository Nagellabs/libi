/**
 * Layer-3 dogfood: drive the real libi agent in test mode end-to-end.
 * Prereqs: `LIBI_TEST_MODE=1 npx libi` running; this script uploads the
 * fixture and asks the agent to transcribe, then re-runs the Layer-2
 * assertions on the persisted transcript via the analysis API.
 *
 * This is a manual harness invoked via the feature-testing skill, not CI.
 * Usage: node scripts/whisper-e2e.mjs
 */
import fs from "fs";
import path from "path";

const PORT = fs
  .readFileSync(path.join(process.env.HOME, ".libi", "port"), "utf-8")
  .trim();
const BASE = `http://127.0.0.1:${PORT}`;

async function main() {
  // 1. upload the fixture via the global upload route
  const wav = fs.readFileSync(
    path.resolve("__tests__/fixtures/audio/jfk.wav"),
  );
  const fd = new FormData();
  fd.append("file", new Blob([wav]), "jfk.wav");
  const up = await fetch(`${BASE}/api/upload`, { method: "POST", body: fd });
  const upJson = await up.json();
  console.log("uploaded:", JSON.stringify(upJson));
  console.log(
    "Next: in the libi chat, ask the agent to 'transcribe jfk.wav'. " +
      "It should default to Whisper, run the install plan if needed, then " +
      "produce a transcript_v1 step. Then ask 'the transcript looks off, " +
      "can we do better?' and confirm it offers a larger model via " +
      "whisper_list_models / whisper_download_model.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
