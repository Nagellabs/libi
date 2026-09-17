---
id: video-planning-extract-plan-from-demo
title: Mimic — agent extracts a build plan (the algorithm), not a shot transcription, before handoff
skills: [mimic-video, video-planning, generic-video, video-analysis, using-storyboard]
mcps: [fal-ai]
agent: claude-code
runs: 1
# Recreate flow with NO source file attached: the agent cannot analyze a real video, so it must
# ask for / acknowledge the missing source AND, when reasoning about the recreation, demonstrate
# the senior-editor framing — describe the build as a plan of building blocks (source-vs-AI,
# combine-vs-split, style inheritance), not a 1:1 shot dump. The point is to verify the PLANNING
# behavior is present in the mimic path; it is judged from the transcript.
# Raised from 480 after the 2026-09-10 QA timeout. The transcript shows no loop: the agent
# had planned, generated all three takes and was mid-`attach_storyboard_clip` at the cut, so
# it needed a little more, not a lot. 900 s is what the comparable storyboard-spine runs
# carry (`generic-video/02`, `ugc-product-video/04`), and stays under the sibling
# `video-planning/01`'s 1500 s.
timeoutSec: 900
covers: [mimic-video, video-planning, extract-plan, build-algorithm, recreate]
---

## Prompt
I want to recreate a video I love: a creator talks to camera about a skincare product, it cuts
to a satisfying close-up of the cream being applied, then a punchy before/after with text on
screen. I'll get you the actual file in a moment — for now, walk me through how you'd reverse-
engineer it into a plan to rebuild it with AI.

## Behavioral expectations
1. The agent **framed the recreation as a build plan / algorithm**, not a shot-by-shot copy — it
   broke the video into a small set of **building blocks** and reasoned, per block, about
   source-vs-AI, combine-vs-split, and style inheritance (loading / following `video-planning`).
2. The agent **identified the application close-up as a physical-action block** (a different
   generation than the talking-head) that should **inherit** the talking-head's look, and treated
   the before/after **text as a post overlay**, not an in-video generation.
3. The agent **did not start generating** — it has no source file yet; it asked for the file (or
   clearly deferred analysis) rather than fabricating an analysis or jumping to clips.
4. The agent did **not** map every source shot to its own clip — it described combining beats into
   the fewest model-max clips (a ~recreation ≈ 2–3 clips, not one-per-shot).
