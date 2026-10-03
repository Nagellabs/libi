---
name: animating-overlays
description: "Animate an overlay or audio clip: slide, zoom, spin or ramp opacity between values (keyframes), or give it an in, out or loop effect: fade in or out, pop, pulse, float, Ken Burns, audio fades, custom effects ('slide the title up', 'fade this in', 'subtle float', 'fade the music out'). Not for text reveals like typewriter or word-by-word (animated-text-overlays)."
tags: [overlays, animation, keyframes, effects]
---

# Animating overlays

Done looks like this: the motion lives on a surface the user can see and edit — keyframe
diamonds on the timeline, or an effect in the Effects panel — and the user can retime it
without you. Never bake motion into a `code` overlay's draw function, and never reach for a
code or three overlay to slide, scale, fade or loop something: a code body is opaque, cannot
be retimed or handed off, and is locked to one overlay.

## Which tool

| The user wants | Use |
| --- | --- |
| An overlay's position, scale, rotation or opacity to go from A to B at times you pick ("slide up", "zoom in", "dim to 40% for the middle") | keyframes: `libi.add_keyframe` |
| A preset entrance, exit or loop, including a plain fade in/out at the overlay's own start/end, pop, pulse, float, Ken Burns, audio fades | an effect: `libi.layer_effect` action `apply` |
| Repeating parametric motion (bob, shake, pulse, wiggle) | an effect, same tool |
| Motion no catalog effect covers, but reusable (in/out/loop of movement, scale, rotation, opacity, blur) | a custom effect: `libi.effect` action `add` |
| Text that reveals itself (typewriter, word-by-word, karaoke, paint-on) | `reveal` on a text overlay: load `animated-text-overlays` |
| A static look (glow, recolor, fixed style) | a caption style (`libi.caption_style({ action: "create" })`), not an effect |
| Motion that is not a transform: particles, a chart drawing itself, generative canvas art | a `code` overlay: the last resort |

Litmus: is the whole overlay moving, scaling, rotating or changing opacity? Keyframes if it is a
one-way change at chosen times, an effect if it is an entrance, exit or loop. A plain fade is an
effect, not keyframes.

## Keyframes

A→B is two `libi.add_keyframe` calls on the same property: the start value at the start time,
the end value at the end time (times are seconds within the overlay's window). Multi-step
motion adds a keyframe per beat; fade-and-slide keys each property in its own pair at the same
times. Pass the property explicitly in both keyframes; omit `properties` only to snapshot
every track as a hold. `easing` shapes the segment leaving that keyframe, so put it on the
start keyframe (presets such as `ease-out`, `overshoot-out`, `bounce-out`, or a
`cubic-bezier(...)`), or change it later with `libi.keyframe({ action: "set_easing" })`. An opacity ramp up
reads best with `ease-out`. `libi.keyframe({ action: "delete" })` and `libi.keyframe({ action: "list" })` remove and inspect.

A tracked overlay's position is track-driven: only `opacity` can be keyframed on it.

## Effects

Effects fill three slots, `in`, `out` and `loop`, which coexist (fade in, gentle float, slide
out). Every overlay kind and every audio clip can carry them.

- `libi.effect` action `list` is the authoritative catalog, custom effects included. Call it before
  applying; an unknown id comes back with the valid set.
- `libi.layer_effect({ action: "apply", pieceId, layerId, phase, effectId, durationMs?, params? })`
  (`layerId` is an overlay or audio clip), `libi.layer_effect` action `clear` to empty a slot. A new
  overlay can be born with motion through `effects` on `libi.add_overlay`.
- Tasteful by default and subtle: a caption or title takes a short `fade` in (300-500 ms), a
  logo or badge a `pop`, a held element a small `pulse` or `breathe` loop, a full-frame photo a
  gentle `zoom` (Ken Burns), an audio clip `audio-fade-in` / `audio-fade-out`. Mirror the
  entrance on exit. One in plus at most one loop is usually enough.
- Audio honours only `in` and `out`. Text reveal effects (`typewriter`, `fade-words`,
  `slide-up-lines`) are text-only and in-only.

```effects
fade
pop
pulse
breathe
zoom
slide
audio-fade-in
audio-fade-out
```

## Custom effects

When `libi.effect` action `list` has no fitting motion, author one instead of baking it into a body:
`libi.effect({ action: "add", id, name, family: "animation", phases, supports, params?, source })`, then
apply it by its new id. `libi.effect({ action: "install_from_git", url })` installs a shared package;
`libi.effect` actions `list_packages`, `update` and `remove` manage them. A
rejected body or manifest returns the reason in `data.hint`: fix it and retry rather than
falling back to a built-in that does not match.

`source` is a pure function body `(progress, params) → TransformDelta`:

- `progress` runs 0→1 across the slot's own window; pace motion off it, never off composition
  frames.
- Return any of `dx, dy, scale, scaleX, scaleY, rotateDeg, opacity, blurPx, clipReveal`; omit
  a field for identity, return `{}` for no change.
- Only the injected helpers (`interpolate`, `spring`, `clamp`, `lerp`, the easing functions)
  exist. There is no canvas, `require`, `import`, `fetch`, DOM or other IO, and a body that
  names one is rejected. The body runs only in libi's sandboxed effect worker, which samples
  it at 1025 values of `progress`; the preview and export interpolate those numbers, so the
  same inputs must give the same output and a sharp step reads as a step.

```js
return { dy: interpolate(progress, 0, 1, 24, 0), opacity: interpolate(progress, 0, 1, 0, 1) };
```

## Handing over

Keyframes and effects stay editable: the user drags diamonds and opens the Keyframes tab's
curve editor, or the Effects panel. When your timing or curve is not quite it, do not keep
guessing: point them at the control (`libi.highlight_effect` flashes an effect in the catalog
or on a layer) and load `guiding-manual-edits`.

Render and look before you tell the user it is done (`libi.render_overlay_frames`, see the
manual's "Putting results in front of the user"): check the start, middle and end of the window.
