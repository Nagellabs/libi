---
id: audio-analysis-elevenlabs-plain-text-upload
title: Asked for a plain-text ElevenLabs transcript, the agent uploads the audio, transcribes it on the flow, and hands the text back without saving it as the file's transcript
skills: [audio-analysis, ai-asset-generation]
mcps: [elevenlabs]
agent: claude-code
runs: 1
timeoutSec: 600
covers: [audio-analysis, elevenlabs, elevenlabs-hosted, asset-upload, presigned-put, transcribe-audio, flat-text-transcript, no-words-less-save]
---

> **Why this scenario exists (2026-09-25).** On ElevenLabs' hosted server a local file
> reaches a model only through an upload: `creative_create_asset_upload` hands back an
> upload URL, the agent PUTs the bytes with exactly the declared Content-Type,
> `creative_finalize_asset_upload` places the file on a flow, and `creative_transcribe_audio`
> reads that node through `connect_from`. The transcript comes back from the status poll in
> `transcripts[].text`. That is FLAT text: a paid live run
> (`docs-local/qa/2026-09-25-fu-B4-live-shapes.md`) showed no per-word timing, no speaker
> labels and no audio events. The fake returns the same shape. It refuses a finalize whose
> bytes never landed, and a PUT with another Content-Type (the studio's
> `/api/test-mode/elevenlabs/upload/…` answers 403).
>
> This chain used to be walked by `02-elevenlabs-diarization-upload`, whose premise
> (speaker labels) turned out to be false and which now asserts the honest refusal instead
> (`02-elevenlabs-no-speaker-labels`). The chain still needs an agent-level test, since it is
> also how a local file reaches the voice changer. So here the user asks for exactly what the
> server can give: plain text, through ElevenLabs, knowing it has no timings.
>
> **Why the user names ElevenLabs.** Whisper is the default and `audio-analysis/01` holds
> that line. On the hosted server ElevenLabs adds no timings, speakers or audio events over
> Whisper, so the reference says the agent tells the user that, and runs it only when they
> still want it. The prompt already says they do. Under the harness's pre-authorization,
> the paid path is the pass.
>
> **Why the text is NOT saved on the file (G5 review, same day).** The first version of
> this scenario asserted a Path B save with `words: []`. That save marks the file's chunks
> `ready` with no timings. Every later Whisper run skips `ready` chunks, so it re-aggregates
> zero words, and `libi.generate_captions` then answers `no_transcript` forever: the file
> could never be captioned. The reference now says to hand the flat text to the user and
> never save it through Path B. The save needles below are `absent`. Chunking (Path B step 1)
> is allowed but not required, since the user supplied the file's path.
>
> **The input.** `__tests__/fixtures/audio/jfk.wav` (~11 s of real speech), repo-relative:
> the harness spawns libi with `cwd: REPO_ROOT`, as `audio-analysis/01` explains.

## Prompt
Upload `__tests__/fixtures/audio/jfk.wav` into this piece — that path is relative to the
directory libi itself is running from, so pass it to `libi.upload_file` as-is — and then
transcribe it with my ElevenLabs, not the on-device model. I know ElevenLabs gives plain
text only; just give me that text.

## Hard invariants
```yaml
assertions:
  - { transcript_contains: ['Launching skill: audio-analysis', 'Launching skill: ai-asset-generation'], expect: present }
  # The upload chain, with the bytes landing before the finalize.
  - { provider: "elevenlabs", tool: "creative_create_asset_upload", expect: present }
  - { provider: "elevenlabs", tool: "creative_finalize_asset_upload", where: "input.flow_id exists", expect: present }
  - { provider: "elevenlabs", tool: "creative_transcribe_audio", where: "input.estimate_only != true", expect: present }
  - { provider: "elevenlabs", tool: "creative_get_flow_run_status", count: ">=2" }
  # The flat text was NOT saved as the file's chunk transcript (either save variant): a
  # words-less `ready` chunk is skipped by every later Whisper run, so captions would be
  # impossible on this file.
  - { transcript_matches: '\[tool-call mcp__libi__libi_analysis_save\][^\n]*"action":\s*"audio_chunk"', expect: absent }
  - { transcript_matches: '\[tool-call mcp__libi__libi_analysis_save\][^\n]*"action":\s*"audio_chunk_from_file"', expect: absent }
  # It did not route around ElevenLabs to the local model it was told not to use for this.
  - { transcript_contains: "[tool-call mcp__libi__libi_analysis_transcribe_audio]", expect: absent }
```

## Behavioral expectations
- Stated the price (`estimate_only`) and the clip length before the first transcription.
  Under the harness's pre-authorization it may then proceed.
- PUT the audio's exact bytes with `Content-Type` equal to the `mime_type` it declared, and
  did not finalize before the PUT succeeded (a refused finalize or a 403 it recovered from
  is acceptable; a guessed transcript is not).
- Read the text from `transcripts[].text` and gave it to the user (in the chat, or a text
  file). It did not fabricate word timings or speaker labels, and said that anything timed,
  such as captions, would come from Whisper.
- Passed a short `context` on every call and never called an `agents_*` tool.
