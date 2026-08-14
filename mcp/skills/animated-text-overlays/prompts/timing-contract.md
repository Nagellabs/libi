# Timing contract (read before writing any draw function)

Every code overlay's draw function receives an **element-local** context:

| field | meaning |
|---|---|
| `progress` | 0→1 across THIS overlay's window. **Use this for pacing.** |
| `time` | seconds since the overlay's `startTime` (0 at the start). |
| `frame` | frame index within the overlay (0 at the start). |
| `totalFrames` | the overlay's own length in frames (duration × fps). |
| `duration` | the overlay's duration in seconds. |
| `width` / `height` | the overlay RECT's size (draw in rect-local coords). |
| `ctx` | the Canvas2D context (already translated to the rect origin). |

This is the SAME contract a canvas scene's draw function sees (scene-local), so
a body that works in a scene works as an overlay unchanged.

**Do:** `const n = Math.round(progress * TEXT.length);`
**Never:** pace off composition frames, e.g. `frame / (totalFrames * 0.7)` while
assuming `totalFrames` is the whole composition — it is NOT; it is this
overlay's frame count. Pacing math that divides by a composition-length
constant will under-reveal (the "Sa" bug).

Helpers available in scope (no import): `interpolate`, `spring`, `stagger`,
`easeIn/Out/InOut`, `easeOutCubic`, `easeOutBack`, `easeOutElastic`,
`drawRoundedRect`, `drawGradient`, and the rest of `DRAW_HELPERS`.
