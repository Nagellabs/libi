---
id: voice-replacement-revoice-ugc
title: Re-voicing an existing UGC clip runs voice-replacement + reaches ElevenLabs (format-aware)
skills: [voice-replacement, voiceover-production, ai-asset-generation]
mcps: [ElevenLabs, fal-ai]
agent: claude-code
runs: 1
timeoutSec: 600
covers: [voice-replacement, revoice, elevenlabs, text-to-speech, format-aware-provider, mute-not-delete, lip-sync]
---

> **STATUS (2026-06-09): LENIENT — asserts the voice-replacement flow reaches the
> fake-ElevenLabs mirror.** Replacing the voice on EXISTING footage must run the
> standalone `voice-replacement` skill (transcribe → choose the voice/provider by
> format → mute-not-delete + re-voice), NOT the generation-time `voiceover-production`
> path (which no longer owns muting).
>
> **The routing under test is a CAPABILITY, not a vendor.** The body used to say
> "a hosted expressive voice provider (ElevenLabs is the one libi recommends)" — the
> only shipped body still recommending a remote vendor, in the exact form removed
> from `music-creation` and that the reference guard now forbids, and unbacked by
> `PROVIDER_CATALOG`, which carries no "recommended" flag. The parenthetical is gone; the
> format→capability routing that is the actual decision stays: a UGC talking-head needs a
> **hosted expressive** voice, not local Kokoro. This scenario's wiring is what makes the
> assertions below still bite — `mcps: [ElevenLabs, fal-ai]` means the one hosted
> expressive provider in the tool list IS ElevenLabs, so "route by capability" and "reach
> ElevenLabs" are the same observable event here. The run is the check that the removal
> did not cost the routing.

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
  # The fal lip-sync half of an earlier split was proven only by a human reading
  # trace.jsonl. Keyed on endpoint_id, never on tool: a tool-keyed assertion passes
  # on the WRONG model.
  - { endpoint_id: "fal-ai/sync-lipsync*", expect: present }
```

## Behavioral expectations
- Used the **`voice-replacement`** skill for the re-voice — recognized it as an
  EXISTING-footage voice change (its own trigger), NOT `voiceover-production` (which is
  generation-time only and no longer owns muting/VO).
- **Transcribed** the clip (local Whisper / analysis) before generating the new voice,
  so the replacement covers the actual spoken content (no under-fill).
- **Routed the provider by FORMAT**: a UGC talking-head → a **hosted expressive voice
  provider**, which in this session is ElevenLabs, and SAID why; would have offered local
  **Kokoro** for a plain narration/explainer. Did not silently force the wrong provider
  for the format, and did not claim libi *recommends* a particular remote vendor.
- **MUTED (`enabled:false`), did NOT delete** the original scene audio — left it on the
  timeline, toggleable.
- For the on-camera talking section: lip-synced via the **fal.ai** model (best:
  `fal-ai/sync-lipsync/v2`) through the `fal-ai` MCP — uploaded the scene video + new audio
  with the fal MCP's own upload tool (the test-mode fake fal exposes no upload tool — if none
  was available, said so plainly instead of hand-rolling one) and disclosed the (paid) cost.
  If no fal provider is connected, fell back to mute + new VO and **disclosed** the lips won't
  match. There is NO local lip-sync tool.
