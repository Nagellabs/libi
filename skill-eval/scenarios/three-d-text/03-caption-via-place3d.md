---
id: three-d-text-caption-via-place3d
title: A plain 3D caption is a TEXT overlay + place3d, not a three/WebGL scene
skills: [animated-text-overlays, three-overlays, speech-captions]
mcps: []
agent: claude-code
runs: 1
covers: [text-overlay, place3d, transform3d, threeD, controllers-first, not-three]
---

## Prompt
I have a piece open. Add a bold 3D caption that says "LAUNCH DAY" — tilt it back a
bit so it has depth and really pops off the screen.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Added the caption as a `kind: "text"` overlay (`libi.add_overlay({ kind: "text" })`),
  NOT a `kind: "three"` WebGL scene and NOT a `code` overlay. A plain "3D caption"
  — static, frontal/tilted, no footage-mapping, no animated 3D scene — is the
  text-overlay-3D path.
- Made it 3D through CONTROLLERS so the values are inspectable + hand-tunable:
  `libi.update_overlay({ place3d: true, transform3d: { rotation: {…}, position: {…} } })`
  for the tilt/depth (`place3d` is settable on update_overlay, not add_overlay), and/or
  `threeD: { depth, … }` for extrusion/thickness. Did NOT hand-write camera or
  perspective math in a `scene.jsx`/`draw.jsx` body.
- The tilt is a real 3D pose (transform3d pitch/yaw or threeD extrusion), not just a
  flat 2D `rotation` roll — but it stays readable, not edge-on.

## Inverse (for the judge's reference — NOT this scenario's prompt)
If the prompt had asked for a 3D *object/scene* (a spinning logo, a 3D diamond), or
for text **mapped onto moving 3D geometry that tracks the footage** (a lyric lying on
a road sliding toward camera), THEN `kind: "three"` would be correct — text-overlay-3D
can't express those. That path is covered by `three-overlays/*`. A loose "real 3D" /
"WebGL" phrasing on a plain caption does NOT by itself justify `three`.
