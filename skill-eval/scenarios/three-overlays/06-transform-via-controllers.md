---
id: three-overlays-transform-via-controllers
title: Reposition/rotate a 3D overlay via transform3d controllers, not a body edit
skills: [three-overlays, guiding-manual-edits]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
covers: [three-overlay, transform3d, controllers-first, no-body-edit]
---

## Prompt
I have a piece open. Add a simple slowly-spinning 3D cube as an overlay. Then rotate
the whole thing about 30 degrees to the right and push it a bit deeper into the frame.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Added the cube as `libi.add_overlay({ kind: "three" })` (an arbitrary 3D OBJECT —
  legitimately a `three` overlay) with a vetted/scaffolded `sceneFunction`.
- Performed the reposition/rotate through CONTROLLERS —
  `libi.update_overlay({ transform3d: { rotation: {…}, position: {…} } })` (and/or
  `cameraPreset`) — and did NOT hand-edit the `scene.jsx` body's camera/scene math to
  move or rotate the whole object. Static placement/orientation is a controller job;
  the body is for the per-frame spin only.
- If the exact angle/depth is subjective, optionally pointed the user at the control
  with `libi.highlight_property({ property: "transform3d.rotation" | "transform3d.position" })`.
