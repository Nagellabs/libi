---
id: using-object-tracking-position-bounce-not-smoothing
title: Position bounce is solved by default stabilization, never by catmull-rom
skills: [using-object-tracking]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
covers: [add_tracked_overlay, update_tracked_overlay, positionMode, smoothing, position-jitter]
---

## Prompt
I added a 👀 emoji that follows the guy's head, but it keeps bouncing up and
down a little every frame even when he stands still. Fix the bouncing.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- The agent treated the bounce as POSITION jitter handled by the render-time
  default `positionMode:"stabilized"` — it checked the overlay's current
  positionMode (via get_overlays / the overlay record) and restored
  `"stabilized"` via `update_tracked_overlay` if it had been set to `"raw"`,
  rather than recomputing the track.
- It did NOT claim `smoothing:"catmull-rom"` (or any `smoothing` change) fixes
  jitter — smoothing is sub-frame interpolation, not a denoiser.
- It did NOT re-anchor / `compute_track_segment` to fix a pure position-jitter
  complaint on the correct subject.
- It did NOT blame or rewrite the emoji content draw code (an emoji content
  has no animation code).
- If it changed anything, it verified visually via `verify_tracked_overlay`
  afterwards rather than declaring success blind.
