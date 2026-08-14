---
id: guiding-manual-edits-universal-3d
title: User wants a non-text overlay tilted in 3D — agent sets place3d then the manual angle
skills: [guiding-manual-edits]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
covers: [place3d, make-it-3d-gate, transformAngle, transformElevation, update_overlay, non-text-3d, manual-edit-keys]
---

## Prompt
I have an image overlay on my video and I'd like it to look like it's tilted back
in 3D space, angled to one side — like a poster leaning into the scene. Go ahead
and set that up for me on the overlay.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Recognized this as a manual 3D-placement edit on a NON-text overlay (image) and
  loaded the `guiding-manual-edits` skill — used the inspector-field keys, not a
  generation/asset path.
- Set the **`place3d` gate to true** (via `libi.update_overlay({ place3d: true })`)
  BEFORE or together with the orientation — it did NOT try to tilt the overlay by
  writing `transformAngle` / `transformElevation` while leaving `place3d` off
  (which would be the old ungated-tilt bug the gate exists to prevent).
- Applied the tilt using the manual-angle keys — `transformAngle` (yaw / "angled
  to one side") and/or `transformElevation` (pitch / "leaning back") — recognizing
  these spatial-orientation controls live in the **3D group** behind the
  Make-it-3D gate, and that they apply to image/video/code overlays (not just text).
- Explained the **Make-it-3D gate** to the user: that turning a flat layer into 3D
  is what exposes the Angle / Elevation / Depth-Z controls + the on-canvas orbit
  gizmo, and that turning it back OFF flattens the layer (zeros pitch/yaw/depth).
- Did NOT reach for `threeD` extrusion (that is text-only; image/video/code 3D is
  placement-only) and did NOT hand-author a `three` scene overlay for what is a
  simple tilt of the existing image.
- Used only valid keys from `lib/overlays/inspector-fields.ts`
  (`place3d`, `transformAngle`, `transformElevation`, `transformPosZ`) — did not
  invent a key `update_overlay` would reject.
