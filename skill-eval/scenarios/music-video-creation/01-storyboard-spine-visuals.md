---
id: music-video-storyboard-spine
title: Music-video AI visuals are built THROUGH the storyboard (card=clip), music deferred
skills: [music-video-creation, using-storyboard, ai-asset-generation, ai-video-models, realistic-image-generation]
mcps: [fal-ai]
agent: claude-code
runs: 1
# Visuals-only run: the user supplies the track + defers music, so the hermetic boot
# never touches the local ACE-Step model. Exercises the AI-visuals-through-storyboard path.
timeoutSec: 900
covers: [storyboard-spine, card-equals-clip, no-opt-off, music-video, keyframe-first]
---

## Prompt
I'm making a music video and I'll add the track and lyric captions myself later — **do NOT
generate any music**. Just build the AI-generated VISUALS through the storyboard: three short
cinematic scenes — (1) a singer on a neon-lit rooftop at night, (2) the same singer walking a
rain-slick street, (3) a wide city skyline at dawn. Generate the clips and place them on the
timeline.

## Hard invariants
```yaml
assertions:
  # Keyframe-first: each clip is animated from a generated start frame.
  - { endpoint_id: "*image-to-video*", expect: present }
  # Three distinct visual scenes => roughly three clips (one per card); must not balloon.
  - { endpoint_id: "*-to-video*", count: "<=5" }
  # Music was deferred as instructed — no music-generation endpoint was called.
  - { endpoint_id: "*music*", expect: absent }
```

## Behavioral expectations
- **Built the visuals THROUGH the storyboard, by default** — invoked `using-storyboard`, created a
  card per scene with `libi.add_storyboard_card`, authored schematics, and showed the board with
  `libi.show_storyboard` before spending. Did NOT run an ad-hoc generate loop that bypasses the
  board.
- **Authored each card's generation spec through the model-schema cache** — `get_model_schema_cache`
  → (on miss) `save_model_schema_cache` → `set_storyboard_generation`, rather than generating blind.
- **Respected card = clip, not card = beat** — three scenes ⇒ ~three cards (one generated clip
  each), placed via `libi.attach_storyboard_clip` + `libi.select_storyboard_take`; did not fragment
  a single scene into many tiny per-beat cards, and did not collapse all three into one.
- **Deferred the music as instructed** — did not generate a track (no local ACE-Step / `music`
  endpoint), and did not block on it; built the visuals and left audio to the user.
- **Did NOT opt off** — the user never said "skip the storyboard", so the agent stayed on the spine.
