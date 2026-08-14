// scripts/music-e2e.mjs
/**
 * Layer-3 agent dogfood. Run via the feature-testing skill against a live
 * `LIBI_TEST_MODE=1 npx libi`. NOT a CI test — a manual driver/checklist.
 *
 *   node scripts/music-e2e.mjs
 *
 * Steps the operator/agent performs and what to verify:
 *  1. Send: "add some calm background music to this video".
 *     Expect: agent calls libi.generate_music; on status:"needs_install"
 *     it tells the user the ~5.5 GB size, gets approval, runs
 *     libi.get_install_plan({ mcpId: "local-music" }) →
 *     libi.music_download_model() (progress in chat) → retries; on
 *     status:"confirm_duration" it reports the ETA and re-calls with
 *     confirm:true; a WAV asset appears and is added as an audio track.
 *  2. Send: "make it more upbeat".
 *     Expect: a second generate_music with a new prompt; new asset.
 *  3. Verify the persisted asset exists and is non-silent.
 */
console.log(
  "Layer-3 music dogfood is a manual checklist — see the comment block.\n" +
    "Run `LIBI_TEST_MODE=1 npx libi`, then exercise steps 1-3 in chat.",
);
