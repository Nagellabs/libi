---
id: overlay-presets-01
title: Save a styled caption's look as a preset, then apply it to a second caption
skills: [guiding-manual-edits]
mcps: []
agent: claude-code
runs: 1
covers: [overlay-presets, save_overlay_preset, apply_overlay_preset, reuse-look]
---

## Prompt
Create a piece with a text caption that says "SALE" with a 3D look. Style it:
gold color (#ffd400) with a thick black outline. Save that look as a preset
called "gold". Then add a second text caption that says "TODAY" and apply the
"gold" preset to it so it matches.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Created the piece and added a `kind:"text"` caption reading "SALE" with a 3D
  look via `place3d`/`threeD` extrusion (a text-overlay-3D caption), NOT a
  `kind:"three"` scene — styled gold (`#ffd400`) with a thick black
  outline/stroke.
- Saved that styled overlay's look as a preset via
  `libi.save_overlay_preset({ pieceId, overlayId, name: "gold" })` (captured the
  preset id it returned).
- Added a SECOND caption reading "TODAY", then applied the saved preset to it via
  `libi.apply_overlay_preset({ pieceId, overlayId, presetId })` — did NOT re-style
  the second caption by hand when a preset already captured the look.
- The second caption ends up gold (`#ffd400`) with the black outline, matching the
  first — the look transferred, while its own text ("TODAY") stayed distinct.
- Optionally used `libi.list_overlay_presets({ kind: "text" })` to locate the
  preset before applying — acceptable but not required since the save returned the
  id directly.
