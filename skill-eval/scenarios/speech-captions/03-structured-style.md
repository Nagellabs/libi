---
id: speech-captions-structured-style
title: Simple readable caption uses structured style fields, not a code overlay
skills: [speech-captions]
mcps: []
agent: claude-code
runs: 1
covers: [structured-caption-style]
---

## Prompt
Add a clean, readable caption that reads "Welcome to the show" and types on over
the first 3 seconds.

## Hard invariants
```yaml
# The skill-eval trace only captures fal/elevenlabs calls — libi MCP tool calls
# (add_overlay, its reveal/stroke/background args) are not in the trace, so
# they cannot be asserted here. The structured-field expectations live in the
# behavioral block below (matching the two sibling speech-captions scenarios,
# which also use an empty hard-invariant block for the same reason).
assertions: []
```

## Behavioral expectations
- Added the caption via `libi.add_overlay({ kind: "text" })` with the STRUCTURED fields —
  `reveal: { mode: "typewriter" }` over the first 3 seconds — and at least one
  readability field (`stroke` outline OR a `background` plate, bottom-safe).
- Did NOT author a code overlay (`add_overlay kind code`) for this simple case.
  A typewriter reveal of fixed text is exactly what the native `reveal` modes
  exist for — reaching for `animated-text-overlays` + a hand-written draw
  function here is a miss.
- Did NOT generate any image/video to fake the caption — it is an overlay added
  in post.
