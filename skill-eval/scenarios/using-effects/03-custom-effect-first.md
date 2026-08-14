---
id: using-effects-custom-effect-first
title: An unbundled motion becomes a reusable custom EFFECT, not per-frame code in the overlay
skills: [using-effects]
mcps: []
agent: claude-code
runs: 1
covers: [effects, add_effect, custom-effect, reusable-artifact, no-hardcoded-motion]
---

## Prompt
I have a piece open with a logo overlay. Make the logo gently bob up and down the whole
time it's on screen.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Checked the bundled catalog first with `libi.list_effects` (a gentle loop bob may
  already exist — if a bundled loop effect fits, applying it via
  `libi.apply_layer_effect` is the right move).
- If no bundled effect fits, AUTHORED a reusable custom effect with `libi.add_effect`
  (a pure `(progress, params) => TransformDelta` body — a `ty` sine bob) and applied it
  via `libi.apply_layer_effect`. Did NOT hand-write per-frame bob motion inside a
  `code`/`three` overlay body.
- Noted (or relied on) that the custom effect is reusable — it appears in the effects
  panel's "Custom" tab and can be applied to other overlays / removed later.

## Inverse (judge reference — NOT the prompt)
A motion that genuinely cannot be a `TransformDelta` (per-frame geometry, particles,
generative paths) legitimately stays a `code` overlay; and a STATIC pixel look
(glow/recolor) is a style/shadow concern, not an effect. A simple up/down bob is none of
those — it is exactly a `TransformDelta` and belongs in a reusable effect.
