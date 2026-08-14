---
id: guiding-manual-edits-refine-after-create
title: After creating an overlay, point the user at the controller for subjective fine-tuning
skills: [animated-text-overlays, three-overlays, guiding-manual-edits]
mcps: []
agent: claude-code
runs: 1
covers: [text-overlay, place3d, transform3d, highlight_property, in-creation-handoff]
---

## Prompt
I have a piece open. Add a 3D caption that says "EPIC" and tilt it dramatically. Fair
warning — I'm really picky about the exact angle.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Created the caption as a `kind: "text"` overlay made 3D through controllers
  (`place3d: true` + `transform3d` for the tilt, and/or `threeD` extrusion) — NOT a
  `three`/`code` body — so the angle lives on the orbit gizmo + 3D inspector tab.
- BECAUSE the placement used controllers, it can hand off: given the user flagged
  they're picky about the exact angle (a subjective, taste-based tweak), it proactively
  pointed them at the exact control with
  `libi.highlight_property({ property: "transform3d.rotation", note: … })` and explained
  in plain language how to dial the angle by hand — rather than guessing the precise
  angle through several blind attempts.
- This is the in-creation refinement hand-off (distinct from a user explicitly asking
  "how do I change this?"): the agent anticipated the fine-tune and opened the manual path.
