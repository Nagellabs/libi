---
id: three-overlays-billboard-default
title: A plain 3D object defaults to a user-facing billboard (not a baked road perspective)
skills: [three-overlays]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
covers: [three-overlay, billboard, default-facing, orientation-contract, transform3d, 3d-object]
---

## Prompt
I have a clip of a city street. Add a slowly spinning 3D diamond / gem shape that
floats in the center of the frame, facing the camera, and glows. I'm not asking
for any particular angle or perspective, just a clean 3D object floating there.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Recognized this is an ARBITRARY 3D OBJECT (a spinning gem/diamond mesh), not a
  plain text caption — so it correctly used a `three` overlay (a plain 3D text
  *caption* would instead be `kind:"text"` + `place3d`, but a 3D object is exactly
  what `kind:"three"` is for).
- Created the `three` overlay via `libi.add_overlay({ kind: "three" })` (capturing
  the returned `codeFilePath`) — NOT a generated video/image faking the object.
- **Defaulted to a BILLBOARD, user-facing object** (`cameraPreset: "billboard"`,
  the frontal vetted default) — because the user asked for no particular
  perspective. Did NOT reach for the road/`ground` perspective look by default.
- **Honored the orientation contract:** the `scene.jsx` body keeps the camera
  FRONTAL — it does NOT aim the camera off-axis (no `camera.lookAt(0, 0, -6)` /
  down-a-road) and does NOT bake a whole-scene placement rotation to lay it flat.
  Content sits at the origin facing the camera, so "Reset 3D" / the Rotation dial
  can reorient it and the user can always bring it back to face them.
- If the agent later adds a tilt/perspective, it does so via `transform3d`
  (e.g. an Elevation `transform3d.rotation.x`), NOT by welding a non-frontal
  camera + baked rotation into the body.
- Followed the build-once + per-frame `update(frameApi)` contract (no meshes
  created inside the update closure; paces the spin off element-local `progress`).
