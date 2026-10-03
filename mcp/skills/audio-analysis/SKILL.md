---
name: audio-analysis
description: "Transcribe a video or audio file: 'transcribe this', 'get the transcript', 'speech-to-text', or any request to pull spoken words and their timings out of media. Free and on-device by default; speaker labels or a named service use the user's own transcription provider. Not for putting captions on the video (speech-captions)."
---

# Audio Analysis (Transcription)

Local Whisper needs no provider. Only a named speech-to-text service or diarization (Path B) needs a **transcription** provider: one in your tool list, else `libi.suggest_provider({ kind: "transcription" })` and stop. Read the `references/providers/<id>.md` here for the one you use before your first call; the full rule is `libi.read_manual({ section: "providers" })`.

Done looks like: the file has a word-timed transcript saved in libi, which is what captions, search and recreation read. Video and audio-only files are handled the same way, and long files are chunked automatically (10 minutes by default; `chunkSeconds` overrides it, do not exceed about 1500).

## Path A — local Whisper (default)

`libi.analysis_transcribe_audio({ fileId })` runs the whole pipeline server-side (extract audio, chunk, faster-whisper per chunk, save, aggregate) and answers with a small status; the words stay in the database. Its schema describes the response.

- `needs_install`: the Whisper model is not downloaded yet. Follow `libi.get_install_plan({ mcpId: "whisper" })` once, then retry. This download never needs approval.
- `partial` or `failed`: retry with `retry: true`, which re-runs failed chunks and chunks that came back with no words, all through local Whisper (so a word-less chunk from a paid provider is re-labelled `whisper`). `libi.analysis_query({ action: "audio_chunks", fileId })` shows what is failing.
- Poor accuracy: quality scales with model size. `libi.whisper_list_models` shows what exists; suggest the next size to the user, and download `medium` (about 1.5 GB) or `large-v3` (about 3 GB) only after the user confirms, then pass `model` to the transcribe call.

## Path B — your own STT provider

Whisper is word-timed but never labels speakers or tags audio events, and `libi.analysis_transcribe_audio` is Whisper-only. Use a `transcription` provider from your own tool list when the user needs speaker diarization, audio-event tags, a named service, or when local Whisper genuinely cannot run (the install keeps failing or the environment cannot support it). Read the provider's reference first: some return flat text only, with no timing and no speaker labels, which then cannot label speakers either.

With no such provider, say so plainly instead of sending the user shopping: libi's own provider is on-device Whisper, which does not diarize, so labels need an STT tool on a provider MCP the user connects themselves. `libi.list_providers()` shows what is connected. Let them choose between connecting one and a non-diarized transcript.

**It is paid: disclose it and ask first.** A hosted STT bills per minute of audio, so give the approximate clip length and cost, and get the user's explicit yes before any call. Switching away from Whisper is never your own initiative. If Whisper fails and no provider is available, tell the user plainly rather than guessing timings or falling back silently.

The pipeline:

1. `libi.analysis_extract({ action: "chunk_audio", fileId })` returns the chunks with `audioPath`, `startSeconds`, `endSeconds`.
2. Call your STT on each chunk's `audioPath`.
3. Save each with `libi.analysis_save` action `audio_chunk` (or `libi.analysis_save` action `audio_chunk_from_file` for a large payload); timestamps are chunk-relative and the server offsets them. The transcript aggregates when the last chunk lands.

**Save only a result that carries word timings.** A flat-text result is never saved here: a save marks the chunks done with no timings, Whisper skips chunks already done, and the file could never be captioned. Give that text to the user instead, and use Whisper for anything timed.

## Related

Frames and summaries are `video-analysis`; it and this skill are independent and run in either order. Searching an existing transcript is `libi.analysis_query` action `search_transcript`. Captions on top of music vocals are `music-video-creation`, which adds sync rules and the larger Whisper model for non-English vocals.
