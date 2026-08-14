---
id: generic-video-storyboard-spine
title: Generic video is built THROUGH the storyboard (card=clip), not an ad-hoc generate loop
skills: [generic-video, using-storyboard, ai-asset-generation, ai-video-models, voiceover-production, realistic-image-generation]
mcps: [fal-ai]
agent: claude-code
runs: 1
# Genre-agnostic single-shot routed through the storyboard. Long agent flow; give it room.
timeoutSec: 900
covers: [storyboard-spine, card-equals-clip, no-opt-off, keyframe-first, native-audio, generic-video]
---

## Prompt
Make an 8-second cinematic AI video: a lone hiker reaching a mountain summit at sunrise, then
turning to camera and smiling (no dialogue). Generate it and assemble it onto the timeline.

## Hard invariants
```yaml
assertions:
  # Keyframe-first: the clip is animated from a generated start frame (image-to-video).
  - { endpoint_id: "*image-to-video*", expect: present }
  # Native audio left ON — no clip generated with audio disabled.
  - { endpoint_id: "*", where: "input.generate_audio == false", expect: absent }
  # One 8s shot is ONE clip (one card) — must NOT fragment into many clips.
  - { endpoint_id: "*-to-video*", count: "<=2" }
```

## Behavioral expectations
- **Built the video THROUGH the storyboard, by default** — invoked `using-storyboard`, created the
  card with `libi.add_storyboard_card`, authored a schematic, and showed the board with
  `libi.show_storyboard` before spending. Did NOT run an ad-hoc generate loop that bypasses the
  board.
- **Authored the card's generation spec through the model-schema cache** — `get_model_schema_cache`
  → (on miss) `save_model_schema_cache` → `set_storyboard_generation`, rather than generating blind.
- **Respected card = clip, not card = beat** — an 8s single shot is ONE card (the summit-reach and
  the turn-to-camera are jump-cut beats INSIDE one card), not one card per beat.
- **Placed the clip via the storyboard** — `libi.attach_storyboard_clip` then
  `libi.select_storyboard_take` (not a bare `create_video_scene`).
- **Did NOT opt off** — the user never said "skip the storyboard", so the agent stayed on the spine.
- **Kept native audio** ON; did not add a separate TTS track for a no-dialogue cinematic shot.
