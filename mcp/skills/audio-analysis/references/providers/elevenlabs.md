# ElevenLabs — provider reference for `audio-analysis`

What the user's own ElevenLabs MCP adds when local Whisper is not enough. libi does not
bundle, configure or supply it, and it is not in libi's transcription catalog — libi's own
transcription provider is on-device Whisper (`libi.analysis_transcribe_audio`). This file
applies only when `speech_to_text` is already in your tool list because the user connected
ElevenLabs themselves; it is never a reason to go and get it.

## What `speech_to_text` adds

It returns the full response including a **`words` array** carrying per-word `start` /
`end`, a `type`
(`word` | `spacing` | `audio_event`) and a `speaker_id`. Local faster-whisper sets
`speaker_id: null` and emits `type: "word"` only, so **speaker diarization** and
**audio-event tags** are the two things this buys. Nothing else about the transcript
improves enough to be worth paying for.

Take the `words` array, not the flat top-level text — the flat string drops the timing
every caption skill downstream depends on. The per-chunk save shape Path B's from-file
variant expects (`{ text, words, language_code?, language_probability? }`) is exactly what
this tool hands back, so no reshaping is needed.

## Driving it

`SKILL.md`'s **`## Path B — your own STT provider`** owns the loop — chunk, call your STT
on each chunk's `audioPath`, save each result, aggregate. Follow it there; it is not
repeated here.

## Cost

Paid, billed per minute of audio, on the user's own ElevenLabs account. **Disclose the
approximate clip length and get explicit approval before the first chunk.** Local Whisper,
including its first-run model download, never needs approval — it is the default, and
switching away from it is never the agent's own initiative.
