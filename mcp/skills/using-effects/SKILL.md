---
name: using-effects
description: Apply tasteful in/out/loop animation effects to any layer — captions, stickers, logos, base scenes, audio. Fade a caption in, pop a logo, gently pulse an emphasis, Ken-Burns a photo, fade audio. "make the title bounce in", "add a subtle float", "fade this out".
when_to_use: When the user asks to animate, add motion to, or "make X move/appear/leave" any overlay, scene, or audio clip — or when adding a new overlay that would look better with motion out of the box.
tags: [overlays, effects, animation]
---

# Using Effects

Effects are time-based animations on a layer's three slots — **in** (entrance),
**out** (exit), **loop** (continuous). They coexist (fade in + gentle float + slide
out). Every overlay kind (including a full-frame base video/image overlay), canvas
scene, and audio clip can carry effects.

## Discover, never guess

`libi.list_effects` is the AUTHORITATIVE, always-current catalog (including custom
effects the user may have installed). Call it — optionally filtered by `kind`,
`phase` — before applying. Treat any ids named in this skill as illustrative, not
exhaustive. An unknown id passed to `apply_layer_effect` comes back with the valid
set; correct and retry.

## Apply

- `libi.apply_layer_effect({ pieceId, layerId, phase, effectId, durationMs?, params? })`
  — `layerId` is any overlay, base scene, or audio clip id.
- `libi.clear_layer_effect({ pieceId, layerId, phase })` — remove one slot.
- New overlays — pass `effects` on `libi.add_overlay` so the layer is born with motion.
- `libi.highlight_effect({ pieceId, target })` — when the user asks how to add an
  effect, or says one looks off, flash it (catalog or applied) so they see the control.

## Tasteful defaults (apply these out of the box)

- **Caption / title text** — `fade` or `typewriter` in. Short (300-500ms).
- **Logo / sticker / badge** — `pop` in. Playful but settles.
- **Emphasis on a held element** — a subtle `pulse` or `breathe` loop (small amount).
- **Photo / image overlay used as a full-frame base** — a gentle `zoom` (Ken Burns) in.
- **Audio clip** — `audio-fade-in` / `audio-fade-out` to avoid hard cuts.
- **Exit** — mirror the entrance (the `out` slot is the time-reverse of `in`), or `fade` out.

Keep it subtle. One in plus maybe one loop is usually enough. Don't stack three loud
effects on one element.

## Layer-kind rules

- Audio clips honor only `in` / `out` (volume fades). `loop` is ignored.
- Text reveal effects (`typewriter`, `fade-words`, `slide-up-lines`) are text-only,
  in-only.
- Base scenes take whole-frame transforms (`fade`, `zoom`, `slide`, `blur`, `shake`,
  `depth-travel`).

## The named effects this skill references

```effects
fade
typewriter
pop
pulse
breathe
zoom
audio-fade-in
audio-fade-out
slide
blur
shake
depth-travel
```

## Custom-effect-first — author motion as a reusable effect, don't bake it into a body

When the user wants a **motion** that isn't already a bundled effect (check
`libi.list_effects` first), PREFER authoring a reusable custom effect with
`libi.add_effect` over baking per-frame motion into a `code`/`three` overlay body.
A custom effect shows up in the effects panel's **Custom** tab and is
reusable + removable across any overlay; motion welded into a draw function is
locked to that one overlay and can't be applied, tuned, or removed from the panel.

The boundary:
- **Motion** (movement, scale, rotation, opacity/blur over time) → a **custom
  effect** (a pure `(progress, params) → TransformDelta` body).
- **A static pixel look** (glow, recolor, a fixed style) → a **style/caption
  style** (`libi.create_caption_style`), NOT an effect.
- **Only motion that genuinely can't be a `TransformDelta`** — per-frame geometry,
  particles, custom canvas drawing — stays a `code` overlay.

## Custom effect packages

When `libi.list_effects` has no motion the user wants, you can extend the catalog
with a **custom effect package** instead of faking it. Two ways in:

- **Author one** — `libi.add_effect({ id, name, family, phases, supports, params?,
  defaultDurationMs?, source })`. You write the motion as an `animate.js` body (the
  `source`). `id` is a lowercase filesystem-safe slug; `family` is `"animation"`;
  `phases` is any of `["in","out","loop"]`; `supports` lists the layer kinds it can
  apply to (`text`, `image`, `video`, `code`, `three`, `tracked`, `scene`, `audio`).
- **Install a shared one** — `libi.install_effect_from_git({ url })` clones, validates,
  and registers a package someone else published.

Then apply it like any built-in — `libi.apply_layer_effect({ pieceId, layerId, phase,
effectId: <the new id> })`. After `add_effect` / `install_effect_from_git`, the new id
is registry-valid; never apply a custom id you have not just created/installed.

### The `animate.js` body contract

The body is a **pure function body** with the signature `(progress, params) →
TransformDelta`:

- `progress` is `0→1` across the slot's own window. `params` is the resolved param
  record (the values for the `params` you declared).
- **Return a `TransformDelta`** — an object with any of these optional fields (omit a
  field for identity; return `{}` or `null` for no change):
  `{ dx, dy, scale, scaleX, scaleY, rotateDeg, opacity (0..1), blurPx,
  clipReveal: { edge, fraction } }`.
- **Pace motion off `progress`, never off composition frames.** Pacing off a
  composition-length constant under-reveals (the same trap as the typewriter bug).
- You may use ONLY the injected pure-math helpers — `interpolate`, `spring`, `clamp`,
  `lerp`, and the easing functions. There is NO `ctx`/canvas, and `require`, `import`,
  `fetch`, `process`, DOM, and any other IO are **forbidden** — a body that references
  one is rejected at validation time (the same sandbox as code overlays). Keep it pure
  math returning a delta.

Example body (a gentle slow drift up + fade):

```js
return {
  dy: interpolate(progress, 0, 1, 24, 0),
  opacity: interpolate(progress, 0, 1, 0, 1),
};
```

### Managing packages

- `libi.list_effect_packages` — list the installed custom effects.
- `libi.update_effect({ id, source?, manifest? })` — patch an existing package
  (re-validated).
- `libi.remove_effect({ id })` — delete a custom package.

A validation failure (forbidden token, bad manifest) comes back as a structured error
with the reason in `data.hint` — fix the body/manifest and retry; don't fall back to a
built-in that doesn't match the request.

## Cross-references

- Captions / text styling — see `speech-captions` and `animated-text-overlays`.
- Snapshot / draft model — see `using-snapshot-draft` (effects edits land in the draft).
