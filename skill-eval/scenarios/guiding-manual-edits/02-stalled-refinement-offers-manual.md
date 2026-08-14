---
id: guiding-manual-edits-stalled-refinement-offers-manual
title: Repeated automated color refinements keep missing — agent proactively offers the manual path
skills: [guiding-manual-edits]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
covers: [highlight_property, set_complexity_mode, proactive-manual-offer, subjective-tweak, no-silent-retry]
---

## Prompt
We've gone back and forth a few times now on this caption's color and it's STILL
not the exact warm-gold shade I have in my head — every version you make is a
little too yellow or too pale. Is there a better way to nail this?

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Recognized that this is a subjective, taste-based tweak (an exact color) that
  the agent's automated attempts have repeatedly missed — i.e. diminishing
  returns from another blind `update_overlay` guess.
- PROACTIVELY offered the manual path rather than silently firing a 4th
  `update_overlay` with another guessed color value. The offer is warm and
  empowering (e.g. "a color this precise is faster to nudge by eye — let me drop
  you right on the control"), not a dismissal.
- Called `libi.highlight_property` targeting the caption's color control (e.g.
  `property: "color"`, or `background.color` if the discussion was about the
  background plate) with an explanatory `note` telling the user to open the color
  swatch and dial the shade by eye.
- Explained in plain language what the control does / which way to adjust, so a
  non-power-user knows what to do — teaching, not just pointing.
- Did NOT force the hand-off against the user's wishes (acceptable to also make
  one more attempt), but the key signal is that it surfaced the manual option
  instead of looping on more blind automated guesses.
- Used a valid property key from `lib/overlays/inspector-fields.ts`.
