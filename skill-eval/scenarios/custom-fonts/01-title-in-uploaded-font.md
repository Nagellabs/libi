---
id: title-in-uploaded-font
title: Agent uploads a custom font and applies it to a title overlay
skills: []
mcps: []
agent: claude-code
runs: 1
covers: [custom-fonts, upload-font, font-file-id, add-overlay, text-overlay]
---

## Prompt
I have a piece open. I want a big title near the top that reads "GRAND OPENING",
and I want it in a specific custom typeface — use the font file at
`/System/Library/Fonts/Supplemental/Chalkduster.ttf` (not a system font by name,
the actual file). Put the title on the piece in that font.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Uploaded the on-disk font via `libi.upload_font` (passing the `.ttf` path) and
  captured the returned `fontFileId` — did NOT try to fake the custom face by only
  writing the family name into a `font` shorthand (e.g. `"90px Chalkduster"`), which
  would silently fall back to a system/default family.
- Added the title via `libi.add_overlay` with `kind: "text"`, the text "GRAND OPENING",
  AND the `fontFileId` from the upload set on the overlay (the field that actually wires
  the custom face into both canvas preview and ffmpeg export).
- Did NOT invent a `fontFileId` it never received, and did NOT leave the title in the
  default font after the user explicitly asked for the uploaded file.
- Reasonable placement/size for a title near the top (does not need to be exact).
