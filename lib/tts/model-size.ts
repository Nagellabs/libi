// lib/tts/model-size.ts
//
// How big the Kokoro download is, in the units the user sees. A LEAF on
// purpose — no imports — for the same reason as `lib/export/chromium-size.ts`:
// `lib/providers/catalog.ts` is reachable from the client (the extension's card
// on the libi MCP tab and the in-chat provider suggestion render `sizeNote`
// before the user decides to install), while
// `lib/tts/voices.ts` and `lib/tts/synthesize.ts` both pull in `node:fs`.
//
// This is THE number. Before it existed there were three hand-maintained
// copies and they disagreed: the catalog said "~350 MB" — the size of the
// FULL-PRECISION `kokoro-v1.0.onnx`, which libi does not download — while the
// TTS code and the manual said "~110 MB". The catalog's copy is the one shown
// to a user deciding whether to install, so the wrong one was the one that
// mattered.
//
// Units: decimal megabytes (1,000,000 bytes), matching every other size libi
// states.

/**
 * `Content-Length` of the two files `fetchModelFiles()` actually downloads,
 * read from the GitHub release assets on 2026-09-09:
 *
 *   kokoro-v1.0.int8.onnx   92,361,271 B   (the INT8 quantized model —
 *                                           `KOKORO_MODEL_URL`)
 *   voices-v1.0.bin         28,214,398 B   (`KOKORO_VOICES_URL`)
 *
 * Pinned by URL, not by version range, so these are stable until
 * `model-files-v1.0` is repointed — which would also invalidate the
 * `KOKORO_ONNX_VERSION` pin next to them.
 */
export const KOKORO_MODEL_BYTES = 92_361_271;
export const KOKORO_VOICES_BYTES = 28_214_398;

/** What the catalog note, the install plan and the agent disclose before the
 *  download starts: "~121 MB". The uv environment built alongside it is not
 *  counted here — this is the model pull `fetchModelFiles()` reports bytes
 *  for, which is what the progress bar the user then watches measures. */
export const KOKORO_DOWNLOAD_MB = Math.round(
  (KOKORO_MODEL_BYTES + KOKORO_VOICES_BYTES) / 1_000_000,
);
