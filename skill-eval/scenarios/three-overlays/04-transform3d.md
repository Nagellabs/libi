---
id: three-overlays-transform3d
title: Static 3D placement uses transform3d (rotation in radians), not hand-edited camera math
skills: [three-overlays, animated-text-overlays]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
covers: [three-overlay, transform3d, transform3d-placement, add_overlay, update_overlay]
---

## Prompt
Add a 3D object overlay and rotate it 45 degrees to the side.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Recognized this needs a REAL 3D object overlay and added it with
  `libi.add_overlay({ kind: "three" })` (NOT `add_overlay({ kind: "text" })` / `{ kind: "code" }` — this is a real 3D object, not text),
  adapting a vetted template (e.g. `simpleObject`) rather than hand-writing the scene.
- Set the 45° side rotation via the structured `transform3d` field —
  `transform3d.rotation.y ≈ 0.785` (45° expressed in RADIANS, Euler XYZ) — on
  `libi.add_overlay` or via a follow-up `libi.update_overlay`, rather than rewriting
  the `sceneFunction`'s camera / scene math to fake the rotation.
- Did NOT hand-edit the scene body (`sceneFunction` / the `scene.jsx` file) to bake in
  this static rotation — static placement belongs in `transform3d` (or the in-canvas
  orbit gizmo), and the agent kept the scene body for the build-once + per-frame
  animation contract.
- Used radians, not degrees, for the rotation value (did NOT pass `45` as the
  `rotation.y`).
- Did NOT generate a video/image to fake the rotated object — it's a 3D overlay
  placed in post.
