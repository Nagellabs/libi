---
id: storyboard-ladder-schematic-before-spend
title: Storyboard ladder — free schematic before paid keyframe; gpt-image-2 keyframe → Seedance clip
skills: [using-storyboard, ai-asset-generation, ai-video-models, realistic-image-generation]
mcps: [fal-ai]
agent: claude-code
runs: 1
# The full ladder (author 2 schematics → wait for watcher renders → char ref →
# 2 keyframes → 2 clips → uploads → approvals → scene placement) is a long
# multi-step agent flow; the 300s default aborts mid-clip. Give it room.
timeoutSec: 900
covers: [storyboard, schematic-before-spend, gpt-image-2, seedance-i2v, character-consistency, no-over-generation]
---

## Prompt
Build a short 2-scene storyboard for this piece that mimics a "filmmaking reel": a
young video-editor character speaking to camera (scene 1, a hook), then a push-in
reveal of the same character at a desk with a laptop (scene 2). Use our storyboard
workflow — plan the scenes first, then generate. Keep the character consistent across
both scenes. Don't spend anything until I've seen the plan.

## Hard invariants
```yaml
assertions:
  # Keyframes use the hardened realism default, not nano-banana.
  - { endpoint_id: openai/gpt-image-2*, expect: present }
  - { endpoint_id: "fal-ai/nano-banana*", expect: absent }
  # Clips are Seedance image-to-video (animated from the keyframes), not text-to-video.
  - { endpoint_id: "bytedance/seedance-2.0/image-to-video*", expect: present }
  - { endpoint_id: "bytedance/seedance-2.0/text-to-video*", expect: absent }
  # Two scenes were requested — must not balloon into many extra generations.
  - { endpoint_id: "bytedance/seedance-2.0/*", count: "<=4" }
```

## Behavioral expectations
- Drafted **Tier-1 schematics first** (authored render-unit files / set blocks via the
  file-edit path) and **presented the board for approval before any paid generation** —
  honoring "don't spend until I've seen the plan."
- Used the storyboard tools for paid/irreversible steps (`attach_storyboard_keyframe`,
  `attach_storyboard_clip`, `approve_storyboard_stage`) and edited card files directly
  for structural changes — did NOT look for nonexistent create/update-card tools.
- Generated each **keyframe with `gpt-image-2`**, conditioned on the card's schematic +
  a **single shared character reference carried across both scenes** (consistency).
- Generated each **clip with Seedance image-to-video from the approved keyframe** (the
  keyframe is the start frame), not from-scratch text-to-video.
- Did NOT over-generate — two scenes ⇒ ~two keyframes + ~two clips, not a flood.
- Disclosed cost before spending (per-card + running) and respected any budget.
