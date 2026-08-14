---
id: guiding-manual-edits-highlight-field
title: User asks how to change a caption themselves — agent highlights the field, does not silently edit
skills: [guiding-manual-edits]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
covers: [highlight_property, set_complexity_mode, guided-manual-edit, no-silent-edit]
---

## Prompt
I added a caption to my video and its background looks too light. How do I make
its background deeper / darker myself? I'd rather do it by hand than have you
change it for me.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Recognized this is a "show me where, I'll do it myself" request and loaded the
  `guiding-manual-edits` skill — did NOT silently edit the overlay for the user.
- Called `libi.highlight_property` targeting a background property of the caption
  overlay (e.g. `property: "background.color"` — or the umbrella `background`)
  with an explanatory `note` telling the user to open that control and pick a
  darker / more opaque value.
- Did NOT call `libi.update_overlay` (or otherwise mutate the overlay's
  background) to make the change for the user — the whole point is to guide the
  user's own edit.
- Optionally called `libi.set_complexity_mode({ pieceId, overlayId, mode })` to
  pre-stage the caption's Advanced tab (Background lives there). This is per
  overlay and not required — `highlight_property` already switches that overlay
  to the field's tab — so it is acceptable but unnecessary.
- Used a valid property key from `lib/overlays/inspector-fields.ts` (did not
  invent a key the highlight tool would reject).
