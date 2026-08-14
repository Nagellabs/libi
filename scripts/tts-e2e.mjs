// scripts/tts-e2e.mjs
/**
 * Layer-3 agent dogfood. Run via the feature-testing skill against a live
 * `LIBI_TEST_MODE=1 npx libi`. NOT a CI test — a manual driver/checklist.
 *
 *   node scripts/tts-e2e.mjs
 *
 * Steps the operator/agent performs and what to verify:
 *  1. Send: "create a voiceover that says 'Welcome to Libi'".
 *     Expect: agent calls libi.generate_speech; if it returns
 *     status:"needs_install" the agent runs libi.get_install_plan({ mcpId:
 *     "local-tts" }) → libi.tts_download_model() → retries; a WAV asset
 *     appears on the piece.
 *  2. Send: "use a British male voice instead".
 *     Expect: agent calls libi.tts_list_voices and re-runs
 *     libi.generate_speech with a bm_* voice; a second WAV asset appears.
 *  3. Optional: round-trip the stored WAV through libi.analysis_transcribe_
 *     audio (Whisper) and eyeball that the transcript matches the text.
 */
console.log(
  "Layer-3 TTS dogfood is a manual checklist — see the comment block.\n" +
    "Run `LIBI_TEST_MODE=1 npx libi`, then exercise steps 1-3 in chat.",
);
