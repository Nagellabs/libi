---
id: storyboard-optional-keyframe-chain
title: Storyboard optional keyframe — agent goes straight to text-to-video, never forces a keyframe
skills: [using-storyboard]
mcps: [fal-ai]
agent: claude-code
runs: 1
# The user explicitly skips the keyframe and asks for text-to-video. The agent must NOT
# generate a keyframe image and must NOT treat the missing keyframe as a blocker — it
# generates the clip directly and places it. (Clip generation itself is judged behaviorally;
# the hard invariant is the crisp fact that NO keyframe image was generated.)
timeoutSec: 420
covers: [storyboard, optional-keyframe, text-to-video, sketch-as-loose-layout, no-forced-keyframe]
---

## Prompt
I have one storyboard scene — a rain-slicked city street at night with neon signs and
reflections. The sketch is just a rough layout idea, that's fine. I don't want to bother
making a keyframe image for this one — generate the clip directly from the prompt
(text-to-video) and put it on the timeline.

## Hard invariants
```yaml
assertions:
  # The user asked to skip the keyframe, so NO keyframe image generation may occur — the
  # skill's keyframe image endpoint must never be called (sketch → keyframe is optional).
  - { tool: run_model, endpoint_id: "openai/gpt-image-2/edit", expect: absent }
  - { tool: submit_job, endpoint_id: "openai/gpt-image-2/edit", expect: absent }
```

## Behavioral expectations
1. The agent did **not** generate a keyframe image — it honored "skip the keyframe" and did
   not treat a missing keyframe as a prerequisite for the clip. (It did not stall, refuse, or
   insist a keyframe is required before video.)
2. The agent created the storyboard card via `libi.add_storyboard_card` and went through the
   schema-cache gate for the **clip** tier (`get_model_schema_cache` → `save_model_schema_cache`
   if missing → `set_storyboard_generation({ tier: "clip", ... })`), setting only the params
   the chosen video model requires — with **no** `start_frame` / keyframe image param
   (text-to-video).
3. The agent generated the clip and placed the resulting take on the timeline
   (`attach_storyboard_clip` → `select_storyboard_take`), and disclosed the clip's cost before
   the paid step.
4. The agent treated the sketch as a loose layout idea — it did not over-invest in the sketch
   or claim the sketch/keyframe was mandatory.
