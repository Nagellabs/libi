---
id: three-overlays-road-caption
title: Perspective lyric caption uses a real 3D overlay, not a flat 2D one
skills: [three-overlays, animated-text-overlays]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
covers: [three-overlay, webgl, add_overlay, perspective-caption]
---

## Prompt
I have a video of a motorcycle riding down a highway. Add the lyric
"EH OH EH" so it lies flat on the road in 3D perspective and slides toward
the camera with the footage — like a flowing 3D lyric mapped onto the ground,
NOT a flat 2D line floating in the middle of the screen.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Recognized this needs REAL 3D / perspective (text mapped onto the ground that
  moves with the footage) and loaded the `three-overlays` skill — did NOT treat
  it as flat kinetic text via `animated-text-overlays`.
- Added the caption with `libi.add_overlay({ kind: "three" })` (NOT
  `add_overlay({ kind: "code" })` / `add_overlay({ kind: "text" })`) — because
  flat Canvas2D has no perspective primitive.
- The `sceneFunction` follows the build-once + per-frame contract: it builds the
  Text once and RETURNS an `update(frameApi)` closure that paces off
  element-local `progress` (NOT composition frames), and does NOT create meshes
  inside the closure.
- Chose `cameraPreset: "ground"` (the road/floor look) and adapted the vetted
  `roadCaption` template rather than hand-writing camera/perspective math.
- Did NOT generate a video/image to "fake" the caption — the caption is an
  overlay added in post.
