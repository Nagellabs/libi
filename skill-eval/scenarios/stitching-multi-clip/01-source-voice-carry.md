---
id: stitch-source-voice-carry
title: Stitch (preserve-creator branch) carries the source creator's voice into faceless AI inserts via @Audio1 (no ElevenLabs)
skills: [stitching-multi-clip, ugc-product-video, voiceover-production, ai-asset-generation, ai-video-models, realistic-image-generation]
mcps: [fal-ai, ElevenLabs]
agent: claude-code
runs: 1
timeoutSec: 600
covers: [stitch, source-voice-carry, reference-to-video, audio-reference, extract-audio-mp3, no-elevenlabs-default, voice-conditioning]
---

> **STATUS (2026-06-08): SOURCE-DEPENDENT → behavioral-only here; the hard run is the
> real-money dogfood test.** A faithful stitch needs real source footage with a speaking
> person to partition + extract a voice sample from, and the skill-eval harness starts each
> scenario from an EMPTY piece (no source-video seeding). So the hard fal/elevenlabs trace
> assertions can't be exercised here — this scenario documents the expected behavior as the
> regression spec, and `docs-local/testing/2026-06-05-ugc-mimic-stitch-dogfood.md` (Test 2′) is the
> live verification. The RUNNABLE proxy for the underlying carry mechanic is
> `ugc-product-video/03-multiclip-voice-carry` (fully-AI @Audio1 carry, hard-asserted); the
> opt-in fallback gate is `_meta/elevenlabs-voiceover`.

## Prompt
Take the talking-head product clip on this piece and turn it into a stitched UGC ad:
keep the real on-camera/voiced moments and fill the connective beats (product close-ups,
b-roll) with AI. I want ONE continuous voice across the whole thing — the creator's own
voice from the original — and no silent gaps.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Routed through `ugc-product-video`'s stitch intake → `stitching-multi-clip`. Recognized this as
  the **preserve-creator branch** — the user explicitly asked to keep themselves on camera ("the
  creator's own voice from the original"), so REUSE the real on-camera/voiced beats, restrict AI
  beats to FACELESS inserts (product/b-roll), and ASK before generating — never silently generate a
  different person. (This is the ALTERNATIVE to the variation default, where the character-driven
  surrounding is *replaced* and the product demo is reused — see scenario `02`.)
- **Loaded the sub-skills BEFORE authoring the plan (ordering gate, 2026-06-08).** Loaded
  `stitching-multi-clip` + `voiceover-production` *before* presenting any beat/voice plan — did
  NOT draft a plan from general knowledge first and reconcile it afterward. The presented plan
  already uses the `reference-to-video` `@Audio1` carry (never a "lay source audio under the AI
  clip as a separate track" plan) and consolidates contiguous faceless beats into ONE model-max
  multi-beat clip (never fragmented 8s+4s+3s short inserts). When recreating a source (the
  `mimic-video` entry), the router does NOT self-author the beat/voice plan — it loads the
  creation sub-skill + `voiceover-production` first and lets them shape it.
- **DEFAULT audio = source-voice carry, NOT cloning.** Identified the main speaker, then
  extracted ONE clean **≤15s MP3/WAV** sample of that speaker's voice via
  `libi.extract_audio({ format: "mp3", startSeconds, endSeconds })` (the new transcode+range path).
- Generated every voiced AI insert on `bytedance/seedance-2.0/reference-to-video` (NOT plain
  `image-to-video`), passing the voice sample as `audio_urls`/`@Audio1` **paired with the insert's
  start frame as `image_urls`/`@Image1`** (the pairing is mandatory — audio alone is rejected),
  with `generate_audio: true` and the beat's narration line in the prompt.
- **Local references reached fal via `libi.upload_file_to_fal` (no credential handling, 2026-06-08).**
  Turned the LOCAL voice-sample MP3 and the LOCAL `@Image1` start frame into fal CDN URLs with
  `libi.upload_file_to_fal({ fileId })` before passing them as `audio_urls`/`image_urls`. Did NOT
  read `FAL_KEY` from the database/env/shell, did NOT request a fal signed upload URL, and did NOT
  `PUT`/`curl` bytes to fal storage — provider credentials stayed inside the server/MCP boundary.
- Reused the SAME `@Audio1` sample on every insert so one voice runs through the piece; the AI
  inserts are voiced in the creator's own voice with no silent holes.
- Did **NOT** call ElevenLabs `voice_clone` / `text_to_speech` — cloning is the explicit opt-in
  fallback, and the user did not ask for it. Did NOT mute the inserts and ship silent gaps. Did
  NOT use Kokoro for the UGC voice.
- Kept the stitch as separate per-beat scenes (no pre-concatenation); no doubled audio on the
  REUSE beats.
