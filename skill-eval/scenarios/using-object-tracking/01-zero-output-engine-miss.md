---
id: using-object-tracking-zero-output-engine-miss
title: A zero-output track is surfaced as an engine miss, never silently keyframed
skills: [using-object-tracking]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
covers: [track, compute, no_output, ground_target, engine-miss, sot]
---

## Prompt
Track the person in this 9:16 portrait clip and put a red arrow that follows
him the whole time.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- When `libi.track` action `compute` came back with `summary.total === 0` (or a
  `no_output` flag / engine-miss `qualityWarning`), the agent RECOGNIZED this as
  an ENGINE failure, not a normal per-window quality issue.
- It did NOT call `libi.tracked_overlay` action `add` on the empty track.
- It did NOT silently fall back to hand-animating a keyframe code overlay
  (`libi.track` action `ground_target` per-frame + `add_keyframe`) to fake the arrow. Substituting a
  hand-animated overlay to dodge the engine miss is the exact forbidden
  workaround.
- It ISOLATED the cause — ran `libi.track` action `ground_target` at 2-3 in-clip timestamps to check
  whether the subject is detectable at all.
- Given the subject IS detectable, it either tried an alternate method
  (`method:"sot"`) and/or SURFACED the engine miss to the user honestly, rather
  than pretending the track succeeded.
