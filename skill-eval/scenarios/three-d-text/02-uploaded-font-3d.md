---
id: three-d-text-uploaded-font-3d
title: 3D title in an uploaded font wires fontFileId onto the threeD text overlay
skills: [three-overlays, animated-text-overlays]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
covers: [three-d-text, text-threeD, upload-font, font-file-id, add-overlay, text-overlay]
---

## Prompt
I have a piece open. Use the font file at
`/System/Library/Fonts/Supplemental/Chalkduster.ttf` (the actual file, not a
system family by name) and make a big 3D extruded title that reads "SUMMER FEST"
in that typeface near the top.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Uploaded the on-disk font via `libi.upload_font` (passing the `.ttf` path) and
  captured the returned `fontFileId` — did NOT fake the custom face by only writing
  the family name into a `font` shorthand (e.g. `"90px Chalkduster"`), which would
  silently fall back to a system/default family.
- Added the title via `libi.add_overlay` with `kind: "text"`, the text "SUMMER FEST",
  a structured `threeD` block (at minimum `threeD.depth`) for the extruded look, AND
  the `fontFileId` from the upload set on the same overlay — so the custom face wires
  into both the 3D-text geometry and the export.
- Did NOT use the `three` code-scene path (`kind: "three"`) or a hand-written code
  overlay for plain 3D text — the depth is the `threeD` field on a text overlay.
- Did NOT invent a `fontFileId` it never received, and did NOT leave the title in the
  default font after the user explicitly asked for the uploaded file.
- Reasonable placement/size for a title near the top (does not need to be exact).
