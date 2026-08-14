---
id: three-d-text-title-real-geometry
title: Plain 3D title uses a text overlay with a threeD block, not a hand-written three scene
skills: [three-overlays, animated-text-overlays]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
covers: [three-d-text, text-threeD, add_overlay, text-overlay, no-three-code]
---

## Prompt
I have a piece open. Add a big 3D title near the top that reads "LAUNCH DAY" —
I want it to look extruded / have real depth, not a flat caption.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Added the title via `libi.add_overlay` with `kind: "text"`, the text "LAUNCH DAY",
  AND a structured `threeD` block (at minimum `threeD.depth`) so the text renders
  extruded — this is the dedicated 3D-text path, where the renderer + export build
  the geometry from a normal text overlay.
- Did NOT reach for the `three` code-scene path (`libi.add_overlay({ kind: "three" })`)
  for what is plain 3D *text* — that path is for arbitrary WebGL objects/scenes and
  would force a hand-written `sceneFunction`; a 3D title belongs on `kind: "text"` +
  `threeD`.
- Did NOT hand-write a draw function / code overlay (`kind: "code"`) to fake the
  extrusion, and did NOT generate an image/video of 3D text — the depth is a
  structured field on the text overlay, applied in post.
- Used a default / bundled face (the overlay's normal `font`) — did NOT require the
  user to supply a custom font file for a plain 3D title.
- Reasonable placement/size for a title near the top (does not need to be exact).
