---
id: video-planning-plan-before-generate
title: Video planning — agent decomposes into building blocks BEFORE generating, doesn't fragment
skills: [video-planning, generic-video, using-storyboard]
mcps: [fal-ai]
agent: claude-code
runs: 1
# A multi-block brief (talking-head → VFX insert → captioned outro). The agent must reason like
# an editor: present a building-block plan (source-vs-AI, combine-vs-split, style inheritance)
# BEFORE spending, map blocks to storyboard cards, and NOT fragment a short video into many tiny
# per-shot clips. The captioned outro's text is a post overlay, never an in-video generation.
#
# HEAVY FULL-BUILD — EXPECTED TO BE SLOW / MAY TIMEOUT on a contended dev box. This runs a full
# plan→keyframe→clip→assemble pass: ~14 real ffmpeg placeholder encodes (fake-fal has NO artificial
# delay; each 1080p clip encode is ~1-2 min on a loaded machine), so wall-clock is 20-40 min and a
# TIMEOUT here is a hardware/budget artifact, NOT a skill regression (same as the bundled UGC
# full-build scenarios — see CLAUDE.md "Skill-Eval TIMEOUT"). On TIMEOUT, JUDGE THE PLANNING
# BEHAVIOR FROM THE PARTIAL transcript.md + the authored storyboard board (storyboard_get output):
# the plan + decomposition + card structure are authored early, well before the slow generation
# tail. The fast, reliable mechanical guards for this skill are scenario 02 (conceptual, no full
# build) + the __tests__/unit/skills/video-planning.test.ts content guard.
timeoutSec: 1500
covers: [video-planning, building-blocks, combine-vs-split, style-inheritance, no-fragmentation, plan-before-spend]
---

## Prompt
Make me a ~20-second vertical video: I talk to camera with a quick hook, then it cuts to a
flashy AI VFX shot of my product glowing and transforming, then back to me for a one-line
outro with a caption on screen. Plan it out first, then build it.

## Hard invariants
```yaml
assertions:
  # Anti-fragmentation: a ~20s, ~3-block video must NOT become a pile of tiny per-shot clips.
  # Generous ceiling (allows a couple of re-rolls) — the plan exists to keep this small.
  - { tool: run_model, endpoint_id: "*video*", count: "<=5" }
```

## Behavioral expectations
1. The agent **presented a building-block plan BEFORE any paid generation** — an ordered list of
   blocks, each with its content, a source-vs-AI decision, and (for split blocks) what it inherits
   from the prior block. It did not jump straight from the brief to generating clips.
2. The agent **split the VFX block from the talking-head block** (a VFX transformation is a
   different generation than a talking-head) AND made the VFX block **inherit the look** of the
   first block — a live `reference_video` link to the prior card's take and/or a carried character
   reference, so colors/scene/style carry. It did not generate the VFX in a vacuum.
3. The agent **combined where appropriate and did not fragment** — it treated this as ~2–3 blocks
   (the two talking-head moments + the VFX), not one clip per sentence/shot.
4. The **captioned outro's text is a post overlay**, not baked into a generated clip (no in-video
   text generation for the caption).
5. The agent built through the storyboard (`libi.add_storyboard_card` per block) and disclosed
   cost before paid steps.
