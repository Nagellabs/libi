---
name: animating-overlays
description: Animate an overlay's MOTION — move / slide / zoom / spin / fade an overlay's position, scale, rotation, or opacity from one value to another over time. Load this whenever the user asks to animate a transform or opacity transition on a text/image/video/code/three overlay. It owns the keyframes-first rule — use `libi.add_keyframe` (visible, user-editable timeline diamonds), NEVER bake the motion into a code overlay's draw function. Triggers — "make the title slide up", "fade this in", "zoom the logo in", "spin it as it enters", "animate it moving across". NOT for text-reveal typewriter/word-by-word (use animated-text-overlays) and NOT for looping/parametric motion like bob/shake/pulse (use effects).
tags: [overlays, animation, keyframes]
---

# Animating Overlays (keyframes)

Use this when the user wants an overlay to **move, slide, zoom, spin, or fade**
— an overlay's **position / scale / rotation / opacity** changing from one value
to another over a window of time. The rule is simple:

> **Animate transforms + opacity with KEYFRAMES, never with a code draw
> function.** A keyframed transition shows as draggable diamonds on the timeline,
> can be re-timed, re-curved (curve editor), and deleted. The same motion baked
> into a `code` overlay's `draw.jsx` is opaque — the user can't see it, can't
> re-time it, and can't hand it off. Keyframes keep the motion on the surface.

## The crisp boundary — keyframes vs. draw-fn vs. reveal vs. effect

| The user wants… | Use | Why |
| --- | --- | --- |
| an overlay to **move / slide / zoom / spin / fade** (a one-way A→B transition of position/scale/rotation/opacity) | **KEYFRAMES** (`add_keyframe`) | visible diamonds, re-timable, curve-editable |
| looping / parametric motion — **bob, shake, pulse, float, wiggle** | an **effect** (`apply_layer_effect` / `add_effect`) | a reusable `(progress)→TransformDelta`, shows in the Effects panel |
| **text reveal** — typewriter, word-by-word, karaoke, paint-on | `reveal` on a `kind: "text"` overlay (skill: `animated-text-overlays`) | native, element-local reveal |
| motion that is NOT a whole-overlay transform — particles, a data-driven chart drawing itself, per-element generative canvas art | a `code` overlay `draw.jsx` (skill: `animated-text-overlays` for kinetic text) | genuinely procedural; no controller expresses it |

**Litmus:** *is this the WHOLE overlay moving/scaling/rotating/fading from one
value to another?* If yes → keyframes. If it's a repeating wobble → effect. If
it's text characters revealing → `reveal`. Only bespoke procedural drawing that
none of those express stays a `code` body. Do NOT reach for a `code` overlay to
"fade in" or "slide up" something — that's exactly the keyframe case.

## Tools

Keyframes are built entirely from **`add_keyframe`** — one call per keyframe.
There is no separate "animate" tool: a simple A→B transition is just **two**
`add_keyframe` calls (start value + end value), and multi-step motion is more.

- **`libi.add_keyframe({ pieceId, overlayId, time, properties?, easing? })`** —
  add (or replace) ONE keyframe at `time` **SECONDS** within the overlay window.
  - `properties` is `{ opacity?, position?, scale?, rotation?, rect?,
    transform3d? }`. `position` is `{ x, y }` in composition pixels; `scale` /
    `rotation` (degrees) / `opacity` are numbers. Pass ONLY the property you're
    animating.
  - **Omit `properties`** to snapshot the overlay's CURRENT values at that time
    (a "hold" keyframe on every track). Only use the omitted form for a hold —
    for an A→B transition pass the property explicitly in BOTH keyframes so just
    that one track is keyed.
  - `easing` shapes the segment **leaving** this keyframe (see "Shaping the
    curve"). Put it on the FIRST (start) keyframe of a segment.
- **`libi.set_keyframe_easing({ pieceId, overlayId, time, easing })`** — set the
  easing on the segment LEAVING the keyframe at `time`, after the fact.
- **`libi.delete_keyframe({ pieceId, overlayId, time })`** — remove the keyframe
  at `time` (across all property tracks).
- **`libi.list_keyframes({ pieceId, overlayId })`** — read the per-track keyframe
  list + the unified time list. Use to inspect / verify before and after.

### The A→B pattern (the common case)

To animate ONE property from A to B over a window, place two keyframes on that
property — start value at the start time, end value at the end time:

- *Fade in over the first second (window starts at 0):*
  1. `add_keyframe({ time: 0, properties: { opacity: 0 }, easing: "ease-out" })`
  2. `add_keyframe({ time: 1, properties: { opacity: 1 } })`
- *Slide up:*
  1. `add_keyframe({ time: 0, properties: { position: { x, y: yStart } } })`
  2. `add_keyframe({ time: <end>, properties: { position: { x, y: yEnd } } })`
- *Combine two properties* (e.g. fade **and** slide) by keying each property in
  its own pair of `add_keyframe` calls at the same start/end times.

For multi-step motion (slide in → hold → slide out), add keyframes at each beat
time — the same property at 3+ times.

## Shaping the curve

The `easing` on a keyframe governs the segment **leaving** it. Pass either a
preset id from `EASING_PRESETS` or a `cubic-bezier(x1,y1,x2,y2)` literal:

- **Presets:** `linear`, `ease-in`, `ease-out`, `ease-in-out` (default),
  `ease-in-strong`, `ease-out-strong`, `ease-in-out-strong`, `overshoot-in`,
  `overshoot-out`, `bounce-out`, `elastic-out`.
- **Custom:** `cubic-bezier(0.2, 0, 0, 1)` for a bespoke curve.

Pick the feel: a fade-in reads best with `ease-out`; a slide-up entrance with
`ease-out` or a little `overshoot-out`; a bouncy pop with `bounce-out` /
`elastic-out`.

## Tracked overlays

A `tracked` overlay's POSITION is track-driven, so only **`opacity`** can be
keyframed on it — `add_keyframe` drops any other property (position / scale /
rotation) for a tracked overlay. Use it to fade a tracked label in/out without
touching its tracked position.

## Workflow

1. **Add / find the overlay.** Create the text/image/video overlay normally
   (`libi.add_overlay`), or find an existing one with `libi.get_overlays`.
2. **Animate the transform/opacity with keyframes.** For a simple entrance
   (fade + slide, zoom in), two `add_keyframe` calls per property — the start
   value and the end value. For multi-step motion, place `add_keyframe`s at each
   beat time.
3. **Shape the curve** with `easing` on the start keyframe (or
   `set_keyframe_easing` after).
4. **Verify.** `list_keyframes` to confirm the keyframes landed, then preview at
   the start / mid / end of the window (or ask the user to scrub). The user sees
   **diamonds on the timeline** and can open the **Effects & Keyframes panel →
   Keyframes tab** to drag them or tweak the curve.

## Look at what you made (required)

After ANY layout, position, size, or typography change — before you tell the
user it is done — render the affected times and look:

`libi.render_overlay_frames({ pieceId, atTimes: [...], contactSheet: true })`

Read the returned image. Check that text fits its box, that nothing overlaps
or runs off frame (`overflow.touchesEdge` flags the obvious cases), and that
`unresolvedFonts` is empty — a family listed there is rendering in a fallback
face and will look wrong. Reasoning about coordinates is not verification:
a real build got the brand mark overlapping its wordmark, a chip 90px too
narrow for its text, and every text in a serif fallback, all of which one
render made obvious.

## Hand-off

Because the motion lives in keyframes (not a draw function), the user can take
over: the timeline diamonds are draggable, and the Keyframes tab exposes the
curve editor. When your own timing/curve isn't quite what they wanted, don't
keep re-guessing — point them at the Keyframes tab and let them dial it by hand.
Load the **`guiding-manual-edits`** skill for the highlight-and-hand-off pattern.
