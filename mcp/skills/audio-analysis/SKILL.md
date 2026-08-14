---
name: audio-analysis
description: Transcribe a video or audio file. Default is local Whisper (faster-whisper, free, on-device). ElevenLabs is opt-in for speaker diarization / audio events or on explicit request. Triggers on "transcribe", "captions", "speech-to-text", or any request to extract spoken text from a media file.
when_to_use: User asks to transcribe, generate captions, or extract speech from a video or audio file. Also use when analyzing a video and the transcript step is needed.
---

# Audio Analysis (Transcription)

Use this skill whenever the user wants a transcript for a video or audio
file. The default provider is **local Whisper** — free, no API key.

## Path A — Whisper (default)

```
libi.analysis_transcribe_audio({ fileId })
```

`provider` defaults to `whisper`. The tool runs the whole pipeline
server-side: extract audio, chunk long files, run faster-whisper per
chunk, save + auto-aggregate into the `transcript_v1` step with
word-level timings.

**First-run bootstrap.** If the response is
`{ status: "needs_install", hint: ... }`, the Whisper model isn't
downloaded yet. Do this once:

1. `libi.get_install_plan({ mcpId: "whisper" })`
2. Follow it — it calls `libi.whisper_download_model({ model: "small" })`
   then `libi.update_dep_status({ mcpId: "whisper", status: "installed" })`.
3. Retry `libi.analysis_transcribe_audio({ fileId })`.

**Response shape:**
```
{ status: "ready" | "partial" | "failed" | "needs_install",
  totalChunks, readyChunks,
  failedChunks: [{ chunkIndex, error }],
  durationSeconds, wordCount, language,
  provider?, hint? }
```

On `ready` — done. On `partial`/`failed` — retry only failed chunks:
`libi.analysis_transcribe_audio({ fileId, retry: true })`. Inspect with
`libi.analysis_get_audio_chunks({ fileId })` if failures persist.

### If accuracy is poor

faster-whisper quality scales with model size. To escalate:

1. `libi.whisper_list_models` — see sizes + what's installed.
2. Suggest the next size up to the user. **Download `medium` (~1.5 GB)
   or `large-v3` (~3 GB) only after the user confirms.**
3. `libi.whisper_download_model({ model: "<bigger>" })`
4. `libi.analysis_transcribe_audio({ fileId, model: "<bigger>" })`

## When to use ElevenLabs instead

ElevenLabs is opt-in. Use it when:
- the user explicitly asks for ElevenLabs, OR
- the transcript needs **speaker diarization** (faster-whisper sets
  `speaker_id: null`) or **audio-event tags** (faster-whisper emits
  `type: "word"` only), OR
- the user finds Whisper quality insufficient even at a larger model.

```
libi.analysis_transcribe_audio({ fileId, provider: "elevenlabs" })
```

Requires the `elevenlabs` MCP installed + `ELEVENLABS_API_KEY` set
(check `libi.list_bundled_mcps`). It bills per minute of audio.

## Path B — BYO STT provider (custom MCP, etc.)

For a non-default STT the agent drives manually:

1. `libi.analysis_chunk_audio({ fileId })` → `{ chunks: [{ chunkId,
   chunkIndex, audioPath, startSeconds, endSeconds }, ...] }`.
2. For each chunk, call your STT with `audioPath`.
3. Save: `libi.analysis_save_audio_chunk({ chunkId, text, words, language?,
   languageProbability? })` (chunk-relative timestamps; server offsets
   them) — or `libi.analysis_save_audio_chunk_from_file({ chunkId,
   jsonPath })` when the payload is large.
4. Auto-aggregates when the last chunk lands.

## Long files

Chunking is automatic (10-min default; override with `chunkSeconds`,
don't exceed ~1500). The agent's response payload stays small regardless.

## Audio-only files

Applies equally to audio-only files (mp3, wav, m4a). Same tools.

## Integration with video-analysis

For full video analysis, this skill handles the transcript; the
`video-analysis` skill handles frames + summary. Independent; either
order.

## Integration with music-video-creation

When the user wants captions on top of music vocals (kinetic typography
lyrics), use `music-video-creation` — it wraps this skill and adds rules
for caption sync (peak-align to vocal onset, no lead offset), declarative
vs code overlays, and Whisper `medium` defaulting for non-English vocals.

## Schema reference

`words[]` items:
```
{ text: string,
  start: number,   // seconds (chunk-relative on save; source-relative after)
  end: number,
  type?: "word" | "spacing" | "audio_event",  // Whisper: always "word"
  speaker_id?: string | null }                 // Whisper: always null
```
Transcript `metadata.schema_version` is always `"transcript_v1"`;
`metadata.provider` reflects the provider used.

## If local Whisper is unavailable (paid fallback — ASK FIRST)

Local Whisper is the free default and `analysis_transcribe_audio` auto-bootstraps
the model on `needs_install`. If, **AND ONLY IF**, local Whisper genuinely cannot
run — the install repeatedly fails, the environment cannot support faster-whisper,
or the model download is impossible — you MAY fall back to a paid STT provider.

**BEFORE any paid STT call:**
1. **DISCLOSE** that it costs money. ElevenLabs bills per minute of audio — state
   the approximate clip length so the user knows the cost exposure.
2. **ASK** the user for explicit approval. Do not proceed until you have a clear
   "yes" or equivalent confirmation.
3. **NEVER** call a paid STT provider without explicit user approval.

Free/local Whisper, including its first-run model download, never needs approval.

To fall back once approved:
- **ElevenLabs** — `libi.analysis_transcribe_audio({ fileId, provider: "elevenlabs" })`.
  Requires the `elevenlabs` MCP installed + `ELEVENLABS_API_KEY` set.
- **Other STT MCP** — drive manually via Path B (chunk → STT → save chunks).

If no STT provider is available at all — local Whisper fails AND no paid
provider/key is configured — tell the user plainly rather than guessing timings
or falling back silently.

## When NOT to use this skill

- Searching an existing transcript: use `libi.analysis_search_transcript`.
- Summaries: that's the `video-analysis` skill.
