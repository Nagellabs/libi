---
name: audio-analysis
description: Transcribe a video or audio file. Default is local Whisper (faster-whisper, free, on-device) via libi.analysis_transcribe_audio. Speaker diarization / audio events, or a named STT, go through the agent's own transcription provider (Path B). Triggers on "transcribe", "captions", "speech-to-text", or any request to extract spoken text from a media file.
when_to_use: User asks to transcribe, generate captions, or extract speech from a video or audio file. Also use when analyzing a video and the transcript step is needed.
---

# Audio Analysis (Transcription)

## Provider gate — read this first

You need a **transcription** provider. libi generates no media itself.

1. **Check your tool list.** If you already have a provider that can do transcription, use it.
   If this skill ships a reference for it — `references/providers/<id>.md` under this
   skill, where `<id>` is the provider's catalog id (`fal`, `elevenlabs`, `higgsfield`,
   `ace-step`, `kokoro`, `whisper`) — **read that file and follow it**. If there is no
   reference file for your provider, use the provider's own tool docs (its
   `get_model_schema` / `list_models` / equivalent) and keep to the capability and
   constraint rules in this skill. **libi's own extension tools count as a provider**
   for their kind — `libi.generate_music` (music), `libi.generate_speech` (voice),
   `libi.analysis_transcribe_audio` (transcription), `libi.remove_background` (matting,
   not generation). Prefer them by default: they are free and on-device. If one answers
   `needs_install`, follow its install flow (`libi.get_install_plan` / the download
   tools) instead of switching provider.
2. **If you have none** — no remote provider tool and no libi extension for transcription — call
   `libi.suggest_provider({ kind: "transcription" })`, tell the user what it showed, and
   **stop**. Do not improvise a provider, do not ask for an API key, and do not fall
   back to a tool that cannot do transcription.
   If it answers `status: "none"`, there is nothing to connect: everything libi knows of
   for transcription is already connected or already installed, and its `covered` list names it.
   Do not open anything or ask for a key — use what `covered` names, or, if that
   cannot do what was asked, say plainly what libi cannot do.

`libi.list_providers()` gives you the same picture without putting a card in the chat — use it
for a general "what's connected?". When the user asks about a provider that is not in your tool
list, call `libi.suggest_provider` instead, so the chat shows the buttons to connect it.

Use this skill whenever the user wants a transcript for a video or audio
file. The default provider is **local Whisper** — free, no API key.

## Path A — Whisper (default)

```
libi.analysis_transcribe_audio({ fileId })
```

The tool is Whisper-only and runs the whole pipeline server-side:
extract audio, chunk long files, run faster-whisper per chunk, save +
auto-aggregate into the `transcript_v1` step with word-level timings.

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

## When you need more than local Whisper

Whisper is local, free, and gives word-level timing but sets `speaker_id: null` and emits
`type: "word"` only. When the transcript needs **speaker diarization** or **audio-event
tags**, or the user asks for a specific STT by name, use a `transcription` provider from
your own tool list through **Path B** below — `libi.analysis_transcribe_audio` is
Whisper-only.

If this skill ships a reference for your provider — `references/providers/<id>.md` under
this skill — read it before you start: it names the tool that returns the `words` array
Path B wants, what it actually buys over Whisper, and how it bills.

If you have no `transcription` provider, say so plainly rather than sending the user
shopping: libi's own transcription provider is on-device Whisper, and it does not
diarize, so speaker labels need an STT tool on a provider MCP the user connects
themselves. `libi.list_providers()` shows what is connected. Let them decide between
connecting one and accepting a non-diarized transcript.

## Path B — your own STT provider

For any STT other than local Whisper — a transcription tool on a provider MCP you have
connected yourself, described in `references/providers/<id>.md` under this skill when one
ships for it — the agent drives the pipeline itself:

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
`metadata.provider` is `"whisper"` for Path A and `"external"` for Path B.

## If local Whisper is unavailable (paid fallback — ASK FIRST)

Local Whisper is the free default and `analysis_transcribe_audio` auto-bootstraps
the model on `needs_install`. If, **AND ONLY IF**, local Whisper genuinely cannot
run — the install repeatedly fails, the environment cannot support faster-whisper,
or the model download is impossible — you MAY fall back to a paid STT provider.

**BEFORE any paid STT call:**
1. **DISCLOSE** that it costs money. A hosted STT bills per minute of audio — state
   the approximate clip length so the user knows the cost exposure.
2. **ASK** the user for explicit approval. Do not proceed until you have a clear
   "yes" or equivalent confirmation.
3. **NEVER** call a paid STT provider without explicit user approval.

Free/local Whisper, including its first-run model download, never needs approval.

To fall back once approved: drive **Path B** with your `transcription` provider —
`libi.analysis_chunk_audio({ fileId })`, call the provider's STT on each chunk's `audioPath`,
save each with `libi.analysis_save_audio_chunk` (or `…_from_file` for a large payload). The
transcript aggregates automatically when the last chunk lands.

If no STT provider is available at all — local Whisper fails AND no paid
provider/key is configured — tell the user plainly rather than guessing timings
or falling back silently.

## When NOT to use this skill

- Searching an existing transcript: use `libi.analysis_search_transcript`.
- Summaries: that's the `video-analysis` skill.
