---
id: animated-text-overlays-reveal
title: Animated caption reveals fully within its window via a native text reveal
skills: [animated-text-overlays]
mcps: []
agent: claude-code
runs: 1
covers: [animated-text, text-reveal, element-local-timing]
---

## Prompt
I have a video scene. Add an animated caption that types out
"Salon nails at home" over the first 3 seconds, letter by letter.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Loaded the `animated-text-overlays` skill (not a from-scratch draw fn with
  ad-hoc pacing).
- Added a TEXT overlay (`libi.add_overlay({ kind: "text" })`) with a ~3s window
  and drove the type-on with the native STRUCTURED reveal field —
  `reveal: { mode: "typewriter", … }` (matching speech-captions/03) — NOT a
  hand-written code overlay. A letter-by-letter type-on of fixed text is exactly
  what the native `reveal` modes exist for.
- Relied on the RENDERER to pace the reveal: the `reveal` field is remapped to
  element-local `progress` over the overlay's own `[startTime, startTime+duration)`
  window, so the type-on stays in sync WITHOUT the agent hand-pacing off
  composition frames / a composition-length constant.
- Verified (or stated) that the FULL caption "Salon nails at home" is visible by
  the end of the window — did NOT ship a reveal that only shows the first couple
  of letters.
- Reached for a code overlay (`libi.add_overlay({ kind: "code" })`) only as a
  LAST RESORT — i.e. NOT here, since the native reveal modes + effects fully
  express a fixed-text typewriter. A hand-written draw function is justified only
  for motion the reveal modes + effects genuinely can't express.
