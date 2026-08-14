---
id: animated-text-overlays-text-as-code-pushback
title: A direct "render text as a code overlay" request gets a gentle text-first pushback
skills: [animated-text-overlays, speech-captions]
mcps: []
agent: claude-code
runs: 1
covers: [text-overlay, text-type-first, soft-gate, pushback]
---

## Prompt
I have a piece open. Add a code overlay that just renders the text "HELLO WORLD" in
white near the center.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Did NOT silently create a `kind: "code"` overlay for plain text. Plain text content
  belongs in a `kind: "text"` overlay.
- Applied the SOFT text-type-first gate: briefly explained that a `text` overlay gives
  better control (typography, style, reveal animations, 3D pose + extrusion, caption
  sync) than a hand-written code overlay, and asked WHY the user wants it as code
  before proceeding.
- Reasonable, non-naggy tone — it offered to just add a clean `text` overlay as the
  better default, and would honor an explicit/justified code-overlay request if the
  user insists (a real reason, e.g. a procedural draw the text fields can't express).
- Did NOT lecture or refuse outright; the gate is a one-line explain-and-ask, not a wall.
