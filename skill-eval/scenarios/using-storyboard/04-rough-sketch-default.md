---
id: storyboard-rough-sketch-default
title: Storyboard rough-canvas sketch default — start slots painted with context.rough, no paid generation
skills: [using-storyboard]
mcps: [fal-ai]
agent: claude-code
runs: 1
# Short planning-only flow: create cards, paint rough-canvas sketches for start slots,
# stop before any paid generation. No video or image models are called.
timeoutSec: 300
covers: [storyboard, rough-canvas-sketch, start-slot, no-spend, no-over-generation]
---

## Prompt
Start a storyboard for a 2-scene ad: scene 1 a cozy kitchen in the morning, scene 2 a
product close-up. Just block out the scenes with sketches — don't generate any images or
video yet.

## Hard invariants
```yaml
assertions:
  # No paid image or video generation — the agent must NOT call run_model or submit_job
  # for any fal endpoint during a sketch-only planning pass.
  - { tool: run_model, endpoint_id: "*", expect: absent }
  - { tool: submit_job, endpoint_id: "*", expect: absent }
```

## Behavioral expectations
1. The agent created storyboard cards via `libi.add_storyboard_card` (one card per scene,
   two cards total) — it did NOT create bare canvas scenes or skip the storyboard tools.
2. For each card's `start` slot, it authored a **rough-canvas illustration** — a unit of
   kind `canvas` whose draw function uses `context.rough` (e.g. `context.rough.rectangle`,
   `context.rough.line`, `context.rough.ellipse`) to render hand-drawn scene art matching
   the scene description — NOT a Satori layout box structure, and NOT the bare default
   scaffold left unmodified.
3. The sketch is **full-bleed**: the draw function fills the canvas area with scene content
   (background color or rough fill covering the frame) with no caption bar, shot-tag box,
   or decorative border baked into the canvas drawing itself.
4. It did NOT pre-paint `end` or `reference` sketches (those are optional, not required
   at planning time) and did NOT call any paid model — image generation and video clip
   creation were explicitly deferred per the user's instruction.
