---
id: storyboard-sketch-slots
title: Card built with start + end sketch slots — an image generated per sketch before the clip
skills: [using-storyboard, ai-asset-generation, ai-video-models, realistic-image-generation]
mcps: [fal-ai]
agent: claude-code
runs: 1
# A single ~8s clip whose start and end frames differ (front view → side view). Exercises
# the role-tagged sketch-slot path: start slot (auto) + an end slot via edit_storyboard_card,
# a keyframe IMAGE generated for EACH sketch, then one image-to-video clip. Long agent flow;
# the 300s default aborts mid-clip. Give it room.
timeoutSec: 900
covers: [storyboard, sketch-slots, start-end-keyframes, keyframe-first, card-equals-clip, no-over-generation]
---

## Prompt
Make a single ~8-second AI clip for a fictional sneaker "Bolt": the shoe rotates on a pedestal
from a front view to a side view. Build it through the storyboard and put it on the timeline.

## Hard invariants
```yaml
assertions:
  # A keyframe image is generated for BOTH the start and the end frame (front view + side
  # view) — at least two gpt-image-2 generations, the hardened realism default, not nano-banana.
  - { endpoint_id: openai/gpt-image-2*, count: ">=2" }
  - { endpoint_id: "fal-ai/nano-banana*", expect: absent }
  # The clip is Seedance IMAGE-to-video (animated between the keyframes), not text-to-video.
  - { tool: run_model, endpoint_id: "*seedance*image-to-video*", expect: present }
  - { endpoint_id: "*seedance*text-to-video*", expect: absent }
  # One ~8s clip is ONE card — the rotation is one motion, must not fragment into many clips.
  - { tool: run_model, endpoint_id: "*seedance*", count: "<=2" }
```

## Behavioral expectations
- **Created role-tagged sketch slots** — the card's `start` slot is created with the card; the
  agent added an `end` slot via `libi.edit_storyboard_card({ addSketch: { role: "end",
  paramKey: "end_frame" } })`, rather than dropping a bare end image with no sketch. (A
  `reference` sketch is optional here and not required.)
- **Refined each slot's sketch, then generated an image per sketch** — drew the front-view and
  side-view sketches (editing each slot's unit file), and generated a keyframe IMAGE for EACH
  with `gpt-image-2`, setting them into the clip spec via `set_storyboard_generation` — BEFORE
  generating the clip.
- **Re-keyed the sketch slots to the model's REAL params so they pair (Finding A guard).** The
  sketch slot's `paramKey` MUST equal the exact key used in `clipGen.params` — Seedance i2v uses
  `image_url` / `end_image_url`, not the default `start_frame` / `end_frame`. The agent re-keyed
  the slots with `libi.edit_storyboard_card({ editSketch: { slotId, paramKey } })` (start →
  `image_url`, end → `end_image_url`) so each sketch pairs with its generated image on the card.
  **Invariant:** after generation, every sketch slot's `paramKey` is a key in the card's
  `clipGen.params` (no orphaned keyframes). For a `reference` slot with no matching i2v param,
  the agent either routed to a reference-capable endpoint or dropped the slot — it did not
  generate an image the clip can't consume.
- **Respected card = clip** — one card, one ~8s clip; the front→side rotation is one motion,
  not two per-beat cards, and not a flood of extra generations.
- **Authored the clip spec through the schema-cache gate** — `get_model_schema_cache` →
  (on miss) `save_model_schema_cache` → `set_storyboard_generation`, not a blind/hand-written spec.
- **Placed via the storyboard** — `libi.attach_storyboard_clip` then `libi.select_storyboard_take`
  to put the scene on the timeline (not a bare `create_video_scene`).
- Disclosed cost before spending; did not over-generate.
