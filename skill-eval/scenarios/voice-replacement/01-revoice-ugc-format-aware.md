---
id: voice-replacement-revoice-ugc
title: Re-voicing an existing UGC clip runs voice-replacement + reaches ElevenLabs (format-aware)
skills: [voice-replacement, voiceover-production, ai-asset-generation]
mcps: [ElevenLabs, fal-ai]
agent: claude-code
runs: 1
timeoutSec: 600
covers: [voice-replacement, revoice, elevenlabs, text-to-speech, format-aware-provider, mute-not-delete]
---

> **STATUS (2026-06-09): LENIENT — asserts the voice-replacement flow reaches the
> fake-ElevenLabs mirror.** Replacing the voice on EXISTING footage must run the
> standalone `voice-replacement` skill (transcribe → choose the voice/provider by
> format → mute-not-delete + re-voice), NOT the generation-time `voiceover-production`
> path (which no longer owns muting). For a UGC talking-head the format-aware
> recommendation is ElevenLabs, not Kokoro.

## Prompt
First, generate ONE short ~8-second UGC talking-head clip of a woman reviewing a
skincare serum — let it speak with its native generated voice. Once it's in the piece,
I've changed my mind about the voice: I want to REPLACE it with a different, more
energetic voice. Re-voice that clip. Pick whatever voice provider best fits a UGC
talking-head, tell me which and why, and KEEP the original audio so I can toggle it
back on later.

## Hard invariants
```yaml
assertions:
  # The re-voice reached the ElevenLabs TTS path (UGC talking-head → ElevenLabs,
  # the format-aware recommendation). This is the headline assertion.
  - { provider: "elevenlabs", tool: "text_to_speech", expect: present }
```

## Behavioral expectations
- Used the **`voice-replacement`** skill for the re-voice — recognized it as an
  EXISTING-footage voice change (its own trigger), NOT `voiceover-production` (which is
  generation-time only and no longer owns muting/VO).
- **Transcribed** the clip (local Whisper / analysis) before generating the new voice,
  so the replacement covers the actual spoken content (no under-fill).
- **Recommended the provider by FORMAT**: a UGC talking-head → **ElevenLabs** (expressive,
  authentic) and SAID why; would have offered local **Kokoro** for a plain
  narration/explainer. Did not silently force the wrong provider for the format.
- **MUTED (`enabled:false`), did NOT delete** the original scene audio — left it on the
  timeline, toggleable.
- For the on-camera talking section: lip-synced via the **fal.ai** model (best:
  `fal-ai/sync-lipsync/v2`) through the `fal-ai` MCP — uploaded the scene video + new audio
  with `upload_file_to_fal` and disclosed the (paid) cost. If `fal-ai` is not configured, fell
  back to mute + new VO and **disclosed** the lips won't match. There is NO local lip-sync tool.
