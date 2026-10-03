---
id: ugc-storyboard-spine
title: UGC ad is built THROUGH the storyboard (card=clip), not an ad-hoc generate loop
skills: [ugc-product-video, using-storyboard, ai-asset-generation, video-generation-craft]
mcps: [fal-ai]
agent: claude-code
runs: 1
# Full UGC flow routed through the storyboard: schematic → keyframe → clip spec via
# the model-schema cache → take → select. Long agent flow; give it room.
timeoutSec: 900
covers: [storyboard-spine, card-equals-clip, no-opt-off, seedance-2.0, native-audio, keyframe-first]
---

## Prompt
Make a short ~12-second UGC ad for a fictional energy drink "Volt", fully AI-generated —
one presenter to camera with a quick hook and a product reveal. Generate it and assemble it
onto the timeline.

## Hard invariants
```yaml
assertions:
  # Keyframe-first: a realistic keyframe is generated before the clip is animated.
  - { endpoint_id: "openai/gpt-image-2*", expect: present }
  - { endpoint_id: "fal-ai/nano-banana*", expect: absent }
  # The clip is Seedance IMAGE-to-video (animated from the keyframe), native audio left ON.
  - { endpoint_id: "bytedance/seedance-2.0/*", count: ">=1" }
  - { endpoint_id: "bytedance/seedance-2.0/*", where: "input.generate_audio == false", expect: absent }
  # One ~12s ad is ONE clip (one card) — must NOT fragment into many per-beat clips.
  - { tool: run_model, endpoint_id: "bytedance/seedance-2.0/*", count: "<=3" }
```

## Behavioral expectations
- **Built the ad THROUGH the storyboard, by default** — invoked `using-storyboard`, created the
  card(s) with `libi.add_storyboard_card`, authored a schematic, and showed the board with
  `libi.show({ target: "storyboard" })` before spending. Did NOT run an ad-hoc generate loop that bypasses the
  board.
- **Authored the card's generation spec through the model-schema cache** — `libi.model_schema_cache` action `get`
  → (on miss) populated via `libi.model_schema_cache` action `save` → `set_storyboard_generation` for the
  keyframe and the clip, rather than generating blind.
- **Respected card = clip, not card = beat** — a single ~12s ad is ONE card (its hook + reveal are
  jump-cut beats INSIDE that one card's prompt/schematic), not one card per beat. Did not fragment
  the ad into several short per-beat clips.
- **Placed the clip via the storyboard** — `libi.storyboard_take` action `attach_clip` then
  `libi.storyboard_take` action `select` to put the scene on the timeline (not a bare `create_video_scene`).
- **Did NOT opt off** — the user never said "skip the storyboard", so the agent stayed on the
  storyboard spine.
- **Kept native audio** ON for the AI clip; did not silently add a Kokoro/TTS voiceover.
