---
id: mimic-video-captions-verify-loop
title: Caption-mimic routes through mimic-video-captions → three-overlays and renders to verify
skills: [mimic-video-captions, three-overlays, animated-text-overlays, video-analysis, audio-analysis]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
covers: [mimic-video-captions, caption-mimic, focus-captions, render_overlay_frames, verify-loop, three-overlay]
---

## Prompt
I uploaded a night-time first-person motorcycle POV reel and I want to copy ITS
on-screen captions onto a new piece. The captions are glowing cyan lyric lines that
sit on the road in perspective — each line appears at the vanishing point down the
highway and rushes/grows toward the camera as the bike rides forward, the baseline
tilting with the road (the classic "lyric on the road" Instagram look), then the next
line replaces it. I want them reproduced faithfully — same look, same motion.

Reproduce that caption treatment on a new 1920x1080 piece — one example line,
"SHOW YOU OFF", over the first 4 seconds is enough to prove the look. Focus ONLY on
the captions; do NOT generate any new video or audio clips.

## Hard invariants
```yaml
# The caption-mimic flow drives libi-core tools (extra_analysis_model focus:captions,
# render_overlay_frames, add_overlay) which are NOT recorded in the fal/elevenlabs
# trace — so they're judged behaviorally below, not asserted here. The one mechanical
# guarantee: reproducing captions on an existing reel must NOT generate any new clips.
assertions:
  - endpoint_id: "*"
    expect: absent
```

## Behavioral expectations
- **Loaded the `mimic-video-captions` skill** (the dedicated caption-mimic flow) — not
  just building captions ad hoc from `mimic-video` or `three-overlays` directly.
- **Recognized this is a 3D / in-perspective caption** (road-mapped, anchored at the
  vanishing point, growing toward the camera) and routed the build to **`three-overlays`
  / `libi.add_overlay({ kind: "three" })`** (vetted template such as `roadCaption`,
  `cameraPreset: "ground"`) — NOT `libi.add_overlay({ kind: "code" })` /
  `libi.add_overlay({ kind: "text" })`. The "glowing cyan + grows" cue does not flatten
  it to a 2D scale-punch.
- **Surfaced / chose the caption-focused paid analysis** — disclosed that mimicking
  captions faithfully is best served by `libi.extra_analysis_model({ focus: "captions" })`
  (paid, ~$0.002/s) for the per-caption motion spec, OR explained it would do so if a real
  source file were attached. (The run is auto-approved, so judge the CHOICE/disclosure, not
  a pause-for-approval.)
- **Ran the render-verify loop:** after adding the 3D caption, called
  `libi.render_overlay_frames` and then OPENED the returned PNG path(s) with its Read tool
  to actually look at the rendered frame, checking for a blank render (yaw-sign footgun) or
  edge overflow, and fixing via `libi.update_overlay` if wrong. A caption added without
  any render_overlay_frames + Read pass is a FAIL for this scenario.
- **Generated nothing.** Did not call any fal/image/video generation to fake the caption —
  captions are overlays added in post over the existing reel.
- Kept the three-overlay build-once + per-frame `update` contract, pacing off `progress`.
