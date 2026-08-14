---
id: storyboard-generation-spec-cache-gate
title: Storyboard generation spec — populate the model-schema cache, set a validated spec, wire scene-to-scene continuity
skills: [using-storyboard, ai-asset-generation, ai-video-models, realistic-image-generation]
mcps: [fal-ai]
agent: claude-code
runs: 1
# Full flow: 2 schematics → 2 keyframes → author clip specs through the schema-cache
# gate → 2 clips → continuity reference → uploads → take selection. Long agent flow;
# the 300s default aborts mid-clip. Give it room.
timeoutSec: 900
covers: [storyboard, generation-spec, schema-cache, validation-gate, continuity-reference, no-over-generation]
---

## Prompt
Build a short 2-scene storyboard for this piece where **scene 2 continues directly from
scene 1**: scene 1 is a slow push-in on a chef plating a dish (hook), and scene 2 is an
extreme close-up orbit of the finished plate. Use our storyboard workflow — plan the
schematics first, then set up each scene's AI generation properly (keyframes plus the clip
parameters for the model you pick) and wire scene 2 so it stays continuous with scene 1.
Don't spend anything until I've seen the plan.

## Hard invariants
```yaml
assertions:
  # Keyframes use the hardened realism default, not nano-banana.
  - { endpoint_id: openai/gpt-image-2*, expect: present }
  - { endpoint_id: "fal-ai/nano-banana*", expect: absent }
  # Clips are Seedance IMAGE-to-video (animated from the keyframes) — any Seedance
  # version (v1/pro or 2.0; the model pick is an ai-video-models concern, the
  # using-storyboard contract is "animate from the keyframe, not text-to-video").
  - { tool: run_model, endpoint_id: "*seedance*image-to-video*", expect: present }
  - { endpoint_id: "*seedance*text-to-video*", expect: absent }
  # Two scenes were requested — must not balloon into many extra clip generations.
  - { tool: run_model, endpoint_id: "*seedance*", count: "<=4" }
```

## Behavioral expectations
- Drafted the **Tier-1 schematics first** and **presented the board before any paid
  generation** — honoring "don't spend until I've seen the plan."
- **Populated the model-schema cache before authoring any clip spec** — called
  `get_model_schema_cache` for the chosen endpoint, and on a miss, fetched/normalized the
  endpoint's API to `GenFieldDef[]` and saved it with `save_model_schema_cache` — rather
  than calling `set_storyboard_generation` blind.
- Set a **generation spec on every card** via `set_storyboard_generation` (no card left
  without one), including `start_frame` + `end_frame` keyframing.
- Wired **scene 2's continuity with a live `reference_video` link to scene 1** via
  `set_storyboard_reference` (paramKey `reference_video`, fromCardId = scene 1) — a live
  link, not a copied/duplicated file.
- If `set_storyboard_generation` returned `schema_cache_missing` or
  `schema_validation_failed`, **recovered by populating the cache / fixing the flagged
  param and retrying** — did not abandon the spec or hand-write card JSON to bypass the gate.
- Generated each **keyframe with `gpt-image-2`** (shared character/style consistency) and
  each **clip with Seedance image-to-video from the keyframe**, then attached the clip as a
  take and selected it onto the timeline.
- Did NOT over-generate — two scenes ⇒ ~two keyframes + ~two clips, not a flood — and
  disclosed cost before spending.
