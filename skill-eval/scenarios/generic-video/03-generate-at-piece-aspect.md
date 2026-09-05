---
id: generate-at-piece-aspect
title: AI video is generated at the piece's aspect ratio, not the model's default
skills: [generic-video, ai-video-models]
mcps: [fal-ai]
agent: claude-code
runs: 1
timeoutSec: 1200
covers: [aspect-ratio, portrait, retrieve_assets_dimensions, generation-defaults]
---

## Prompt
This piece is set up for TikTok — it's a vertical 1080x1920 canvas. Generate a
single 5-second clip of a coffee cup on a wooden table with morning light coming
through a window, and put it in the piece as the background.

## Hard invariants
```yaml
assertions:
  # The whole point: the clip must be generated VERTICAL. A 16:9 generation
  # would have to be cropped or pillarboxed into the frame, which is exactly
  # the silent failure the aspect guidance exists to prevent.
  - { endpoint_id: "*", where: "input.aspect_ratio == 9:16", expect: present }
  - { endpoint_id: "*", where: "input.aspect_ratio == 16:9", expect: absent }
  # Deliberately NO "did not also generate an image" assertion here. The
  # keyframe-then-clip pattern is the documented default in the generic-video
  # and using-storyboard skills, so one image generation is correct behaviour,
  # not over-generation. An `expect: absent` on an image endpoint would also
  # match free get_model_schema introspection calls, not just generation.
```

## Behavioral expectations
- Established the piece's aspect ratio before generating — via
  `libi.retrieve_assets_dimensions`, or from context it already had (this
  prompt states the canvas, so a tool call is not required). Did NOT generate
  first and discover the mismatch afterwards.
- Passed an explicit vertical `aspect_ratio` to the generation model rather than
  leaving it unset and inheriting the model's own default (usually 16:9).
  Generation MCPs are separate servers; libi does not rewrite their params.
- Added the result as a full-frame video overlay sized to the 1080x1920 canvas.
- Did NOT resize the canvas to fit a horizontal clip — the user stated the piece
  is for TikTok, so the frame is the fixed constraint and the generation adapts.
