---
id: animating-overlays-fade-slide
title: A title that fades in and slides up is keyframed, not baked into a code overlay
skills: [animating-overlays]
mcps: []
agent: claude-code
runs: 1
covers: [overlays, keyframes, add-keyframe, easing, transform-not-code]
---

## Prompt
I have a piece open. Add a title text overlay that reads "Grand Opening" near the
top, and have it fade in and slide up over the first second.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Added the title as a `kind: "text"` overlay (NOT a `code` overlay) reading
  "Grand Opening" near the top.
- Animated the fade + slide with KEYFRAMES — used `libi.add_keyframe` with two
  calls per property (a start + end keyframe: `opacity` 0→1 and `position` for the
  upward slide). Did NOT author a `code` overlay `drawFunction` to animate the
  opacity/position — the whole point is the motion stays as timeline diamonds the
  user can re-time and re-curve.
- Scoped the motion to roughly the first second of the window (via explicit
  keyframe times), not the whole clip.
- Set a sensible easing on the motion (e.g. `ease-out` for the fade/slide entrance)
  via the `easing` param or `libi.set_keyframe_easing` — did not leave it as a bare
  linear ramp if a nicer entrance curve was obviously appropriate.
- Did NOT reach for a code/three overlay to accomplish a plain transform+opacity
  transition, and did NOT confuse this with a text-reveal (typewriter) or a looping
  effect (bob/pulse) — this is a one-way keyframed A→B transition.
