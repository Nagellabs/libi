---
id: meta-elevenlabs-voiceover
title: Agent reaches ElevenLabs only on explicit opt-in voiceover request
skills: [voiceover-production, ai-asset-generation]
mcps: [ElevenLabs]
agent: claude-code
runs: 1
timeoutSec: 540
covers: [elevenlabs, voiceover, opt-in-voiceover, text-to-speech]
---

> **STATUS (2026-06-05): LENIENT — asserts the fake-ElevenLabs mirror is reached.**
> The user EXPLICITLY asks for a single ElevenLabs voiceover, so the opt-in path
> in `voiceover-production` should run `text_to_speech` (optionally `voice_clone`)
> against the test-mode fake and import the resulting audio. This proves the
> ElevenLabs tool path end-to-end at zero cost.

## Prompt
I have a finished 12-second product video already in this piece. I want you to
replace its audio with ONE consistent human-sounding **ElevenLabs** voiceover
across the whole thing — script it yourself ("Meet AquaFlow, hydration that
keeps up with you."). Use ElevenLabs specifically, not the on-device voice.
Generate the voiceover and add it to the piece.

## Hard invariants
```yaml
assertions:
  # The agent reached the ElevenLabs TTS path (the headline assertion).
  - { provider: "elevenlabs", tool: "text_to_speech", expect: present }
  # It did NOT silently fall through to a fal endpoint for the voice.
  - { provider: "fal", expect: absent }
```

## Behavioral expectations
- Honored the explicit "ElevenLabs specifically" instruction — used the
  `text_to_speech` (or `voice_clone` + `text_to_speech`) tool, not Kokoro.
- Imported the returned audio file into the piece via `libi.upload_file`.
