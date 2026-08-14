---
id: overlay-gets-tasteful-in
title: Adding a caption applies a tasteful in effect
skills: [using-effects]
mcps: []
agent: claude-code
runs: 1
covers: [effects, apply-layer-effect, tasteful-defaults, list-effects]
---

## Prompt
I have a piece open. Add a title caption that reads "Summer Sale" near the top,
and make it animate in nicely. Keep it tasteful — don't overdo the motion.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Discovered effects via `libi.list_effects` (did not invent an effect id from memory).
- Added the caption (via `libi.add_overlay` with an `effects.in`, OR added it then
  called `libi.apply_layer_effect`) with a sensible IN effect — `fade`, `typewriter`,
  or `pop` — and a short duration (~300-600ms).
- Did NOT stack multiple loud effects or add an unrequested loud loop.
- Used a real, registry-valid effect id (no `unknown_effect` error left unresolved).
