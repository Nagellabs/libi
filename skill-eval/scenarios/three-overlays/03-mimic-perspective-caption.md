---
id: three-overlays-mimic-perspective-caption
title: A road-mapped perspective lyric caption routes to three-overlays, not flat 2D code
skills: [three-overlays, animated-text-overlays, video-analysis]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
covers: [three-overlay, add_overlay, perspective-caption, flat-vs-perspective, mimic-caption]
---

## Prompt
I have a night-time first-person motorcycle POV reel. The lyric captions are the
thing I want to copy. They're glowing hot-pink neon text with a punchy scale-up —
BUT each line is laid onto the road in perspective: it sits at the vanishing point
down the highway and rushes/grows toward the camera as the bike rides forward, the
baseline tilting with the road. It's the classic "lyric on the road" Instagram look,
not a flat caption parked in the middle of the screen.

Recreate that caption treatment on a new 1920x1080 piece — just one example line,
"SHOW YOU OFF", over the first 4 seconds. Focus only on the caption look; do NOT
generate any video or audio.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Recognized this is a **3D / in-perspective** caption (road-mapped, anchored at the
  vanishing point, growing toward the camera as the bike moves) and NOT a flat 2D
  effect — despite the "glowing hot-pink neon + scale-up punch" cues that on their own
  point at flat kinetic text. A 2D zoom/scale punch is not perspective.
- Loaded the `three-overlays` skill and added the caption with
  `libi.add_overlay({ kind: "three" })` (using a vetted template such as
  `roadCaption` and `cameraPreset: "ground"`), NOT
  `libi.add_overlay({ kind: "code" })` / `libi.add_overlay({ kind: "text" })`.
- Did NOT flatten the caption into a centered 2D Canvas2D code overlay — if it
  consulted `animated-text-overlays`, it followed that skill's flat-vs-perspective
  gate and switched to `three-overlays`.
- Kept the build-once + per-frame `update` contract, pacing off `progress`.
- Did NOT generate any video/image to fake the caption — it's an overlay added in post.
