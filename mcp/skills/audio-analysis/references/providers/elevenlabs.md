# ElevenLabs — provider reference for `audio-analysis`

What the user's own ElevenLabs MCP can and cannot do for a transcript. libi does not
bundle, configure or supply it, and it is not in libi's transcription catalog — libi's own
transcription provider is on-device Whisper (`libi.analysis_transcribe_audio`). This file
applies only when `creative_transcribe_audio` is already in your tool list because the user
connected ElevenLabs themselves; it is never a reason to go and get it. How its tools are
called is in `ai-asset-generation`'s `references/providers/elevenlabs.md`: flow runs, the
required `context`, the `estimate_only` price, polling, and sending it a local file.

## What `creative_transcribe_audio` returns: flat text only

The status poll's `transcripts[].text` (the same text is served as a .txt at
`download_url`). There is **no per-word timing, no speaker labels and no audio events**, and
the hosted tools have no option that asks for them. Local Whisper returns the same kind of
text WITH word-level timing, free and on-device, so on this server ElevenLabs adds no
timings, speakers or audio events over Whisper.

- **Asked for speaker labels (diarization) or audio-event tags through ElevenLabs:** tell
  the user plainly that the connected ElevenLabs can't label speakers or tag audio events —
  its transcription returns plain text only — and don't spend on it. Offer what can be done:
  a free Whisper transcript with word timings but no speaker labels. Let them choose.
- **Captions or anything timed:** use Whisper. Text without timings can't place a caption.
- **The user wants ElevenLabs' plain text anyway:** say it adds no timings, speakers or
  audio events over Whisper and costs credits. Only with their yes, drive it as below.

## Driving it (plain text, never saved as the file's transcript)

Take the audio from `SKILL.md`'s **`## Path B — your own STT provider`** step 1 (its
chunks' `audioPath`s), or use the file itself when you already have its path. Upload it
onto a flow (the reference's "Sending it a local file"), call
`creative_transcribe_audio({ model_id: "eleven_scribe_v1", flow_id, connect_from: [<the
node_id>], context })`, and poll `creative_get_flow_run_status` until the result is in
`transcripts`. **Then give the user that text**, in the chat or in a text file if they
ask.

**Do not save it through Path B's save step.** A save marks the file's chunks as
transcribed with no word timings. A later Whisper run skips chunks already marked done,
so that file could never be captioned. Anything timed on the file comes from Whisper.

## Cost

Paid, billed per minute of audio, on the user's own ElevenLabs credits. The charge (a
generation's `price.credits`) is fractional. **Disclose the approximate clip length and the
`estimate_only` price, and get explicit approval before the first chunk.** Local Whisper,
including its first-run model download, never needs approval — it is the default, and
switching away from it is never the agent's own initiative.

If your tool list shows the older local server's `speech_to_text` instead, read its own
description: it may take a `diarize` option and return per-word timing. If it does, save
those `words` with their `speaker_id`s; if not, the rules above hold. Same cost rule.
