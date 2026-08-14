---
id: three-overlays-update-and-preset
title: Editing a 3D overlay uses update_overlay in place + a non-default camera preset
skills: [three-overlays, animated-text-overlays]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
covers: [three-overlay, update_overlay, camera-preset, in-place-edit, lowAngle]
---

## Prompt
Add a 3D badge/emblem (a metallic medal-style disc with a star on it) floating in
the center of the frame, facing the camera. The piece is 1920x1080 and 6 seconds
long; put it over the whole frame for the first 4 seconds.

Then — keep that exact same badge, don't start a new one — restage it so the
camera looks up at it from a dramatic low angle (like a hero shot from below).

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Recognized this needs a REAL 3D OBJECT overlay (a floating badge/emblem mesh
  facing the camera with depth) and loaded the `three-overlays` skill — added the
  initial badge with `libi.add_overlay({ kind: "three" })` (NOT
  `add_overlay({ kind: "text" })` / `add_overlay({ kind: "code" })`), using the
  `billboard` cameraPreset.
- For the restage, EDITED THE EXISTING overlay with `libi.update_overlay`
  on the same `overlayId` — did NOT `remove_overlay` + `add_overlay`, and
  did NOT create a second 3D overlay.
- Chose `cameraPreset: "lowAngle"` for the "looking up from below / hero shot"
  request (the new preset), rather than hand-writing camera math or leaving it on
  `billboard`.
- Kept the build-once + per-frame-`update` contract, pacing off `progress`.
- Did NOT generate any video/image to fake the badge — it's an overlay added and
  edited in post.
