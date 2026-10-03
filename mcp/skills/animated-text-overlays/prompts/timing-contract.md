# Timing contract (read before writing any draw function)

Every code overlay's draw function receives an **element-local** context:

| field | meaning |
|---|---|
| `progress` | 0→1 across THIS overlay's window. **Use this for pacing.** |
| `time` | seconds since the overlay's `startTime` (0 at the start). |
| `frame` | frame index within the overlay (0 at the start). |
| `totalFrames` | the overlay's own length in frames (duration × fps). |
| `duration` | the overlay's duration in seconds. |
| `compositionTime` | this frame's absolute time on the piece's timeline (seconds). |
| `overlayStart` | where this overlay starts on the timeline (seconds). |
| `pieceDuration` | how long the piece runs (seconds). |
| `width` / `height` | the overlay RECT's size (draw in rect-local coords). |
| `ctx` | the Canvas2D context (already translated to the rect origin). |

Timing is ELEMENT-LOCAL: the clock starts at the overlay's own `startTime`, not
at the composition's zero. A body written against one overlay's window behaves
identically in another.

Never hard-code a composition time in a body (`const T = time + 7.6`, `NARRATION_OFFSET = 8.3`).
When the body must line up with something on the piece's timeline, read `compositionTime`,
`overlayStart` or `pieceDuration`: they follow the overlay when it is retimed, a constant does not.
Caption `words` stay in overlay-local seconds: pair them with `time`.

**Do:** `const n = Math.round(progress * TEXT.length);`
**Never:** pace off composition frames, e.g. `frame / (totalFrames * 0.7)` while
assuming `totalFrames` is the whole composition — it is NOT; it is this
overlay's frame count. Pacing math that divides by a composition-length
constant will under-reveal (the "Sa" bug).

Helpers available in scope (no import): `interpolate`, `spring`, `stagger`,
`easeIn/Out/InOut`, `easeOutCubic`, `easeOutBack`, `easeOutElastic`,
`drawRoundedRect`, `drawGradient`, and the rest of `DRAW_HELPERS`.
