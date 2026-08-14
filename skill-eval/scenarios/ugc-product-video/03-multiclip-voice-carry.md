---
id: ugc-multiclip-voice-carry
title: 25s UGC carries one voice across clips via reference-to-video
skills: [ugc-product-video, ai-asset-generation, ai-video-models, stitching-multi-clip, voiceover-production, realistic-image-generation]
mcps: [fal-ai]
agent: claude-code
runs: 1
timeoutSec: 540
covers: [seedance-2.0, reference-to-video, voice-carry, native-audio, no-kokoro, multi-clip]
---

> **STATUS (2026-06-05): PASSING — sub-project C (the audio restructure) landed.**
> A real claude-code run now HARD-PASSes: the agent carries one voice across
> clips via `reference-to-video` (`audio_urls`/`@Audio1`), keeps native audio on
> every seedance clip (0 muted), and generates NO separate ElevenLabs/TTS/Kokoro
> voiceover. Before C it muted the clips and layered an ElevenLabs VO; the new
> `voiceover-production` authority skill + the deleted escape hatch fixed it.
> Do not "fix" this by loosening the matchers — the matchers are correct; this
> scenario is the regression guard for the carry behavior.
>
> **2026-06-08: this is also the RUNNABLE guard for the new stitch default**
> (carry the source creator's voice into AI inserts via `@Audio1` rather than
> cloning). The stitch-specific flow is source-dependent so it lives as a
> behavioral-only spec in `stitching-multi-clip/01-source-voice-carry`; the
> `@Audio1` carry + no-ElevenLabs-by-default mechanic it relies on is exactly
> what this scenario hard-asserts.

## Prompt
Create a 25-second fully-AI UGC ad for a fictional energy drink "Volt". The SAME
spokesperson appears and speaks throughout, and her voice must sound consistent
across the entire ad — one continuous voice, not a different voice per shot.
Generate the clips and assemble them into the 25-second piece.

## Hard invariants
```yaml
assertions:
  # 25s > the ~15s single-clip ceiling → must be 2+ clips. Clip 1 establishes
  # the voice on image-to-video; clip 2+ carries it on reference-to-video.
  - { endpoint_id: "bytedance/seedance-2.0/image-to-video", count: ">=1" }
  - { endpoint_id: "bytedance/seedance-2.0/reference-to-video", count: ">=1" }
  # Native audio must stay ON for every Seedance clip (the voice IS the native
  # audio — muting it and layering TTS is the regression).
  - { endpoint_id: "bytedance/seedance-2.0/*", where: "input.generate_audio == false", expect: absent }
```

## Behavioral expectations
- Carried ONE voice across clips by passing clip-1's native audio into the
  reference-to-video `audio_urls` (cited as `@Audio1`) + the character image in
  `image_urls` (`@Image1`) — NOT by generating a separate Kokoro / ElevenLabs / TTS
  voiceover track.
- Used the `@Image1` / `@Audio1` reference tokens ONLY on the reference-to-video
  call (never injected them into a plain image-to-video prompt).
- Kept native audio on for all clips; the spoken lines come from the generations.
- Did NOT reach for ElevenLabs `voice_clone`/`text_to_speech` to unify the voice —
  the `@Audio1` carry is the default; cloning is the explicit opt-in fallback (the
  same default that governs a stitch's faceless AI inserts as of 2026-06-08).
