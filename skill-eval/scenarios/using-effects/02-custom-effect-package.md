---
id: custom-effect-package
title: Agent authors a custom slow-drift effect and applies it to a title
skills: [using-effects]
mcps: []
agent: claude-code
runs: 1
covers: [effects, custom-effect-package, add-effect, animate-js, apply-layer-effect, progress-paced, sandbox]
---

## Prompt
I have a piece open with a title caption already on it. I want a gentle "slow drift"
entrance where the title eases upward a little while fading in over about a second —
none of the built-in effects feel right. Make that motion and put it on my title.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Recognized the catalog lacks the wanted motion and reached for a CUSTOM effect —
  called `libi.add_effect` (NOT `install_effect_from_git`, since the user wants a new
  motion authored, not a shared package) with `family: "animation"`, an `in` phase, and
  `supports` including `text`.
- The authored `animate.js` `source` body returns a `TransformDelta` (e.g. `dy` +
  `opacity`) and **paces the motion off `progress`** — not off composition frames /
  a length constant.
- The body is pure: it uses only injected math helpers (`interpolate`, `spring`,
  `clamp`, `lerp`, easing) and references NO `ctx`/canvas, `require`, `import`, `fetch`,
  `process`, DOM, or other IO (otherwise validation rejects it).
- After creating the effect, applied it to the title via `libi.apply_layer_effect`
  using the NEW effect id (the slug it just registered), on the `in` phase — did NOT
  apply a built-in id, and did NOT hallucinate an effect id it never created.
- Did not leave an `unknown_effect` / validation error unresolved; on any validation
  failure it corrected the body/manifest and retried rather than falling back to a
  mismatched built-in.
