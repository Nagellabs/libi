---
name: animated-text-overlays
description: "Add or fix animated text: typewriter or letter-by-letter reveals, word-by-word fades, slide-up, pop, gradient shine, lower-thirds, kinetic hooks and titles ('make the caption type out', 'the animated caption is cut off'). Load before hand-writing a code overlay that animates text. Not for subtitles synced to speech (speech-captions) or plain static text (a text overlay)."
tags: [overlays, text, animation]
---

# Animated text overlays

Done looks like this: the text animates as asked, the whole text is visible by the end of the
reveal (never a truncated "Sa"), and the user can retune it in the inspector. Subtitles synced
to speech belong to `speech-captions`; plain static text is `libi.add_overlay({ kind: "text" })`.

## Set controller fields, not code

Build the look by setting declarative fields on a `kind: "text"` overlay: `reveal.mode` for
motion, `threeD` plus `place3d` / `transform3d` for depth, the style fields (`color`,
`background`, `stroke`, `shadow`, font) for the look. A field lands on the gizmo and the
inspector, stays tunable, and you can point the user at it with `libi.highlight_property`; a
look baked into a draw function is none of those.

- `reveal.mode`: `typewriter`, `fade-words`, `slide-up`, `pop`, `karaoke` (full line, active
  word in `reveal.highlightColor`), `word-current` (only the active word shows). The renderer
  paces them off the overlay's own window.
- `reveal: { mode: "flythrough", direction }` paints text on across a 3D plane. It requires
  `threeD`; `direction` is `ltr`, `rtl` or `through`, and `sideOffset` tunes the sweep angle.
- Extruded or tilted 3D text is still `kind: "text"` (`add_overlay`, then `update_overlay({
  place3d: true, transform3d })`, plus `threeD` for thickness). Only an arbitrary 3D object or
  scene, or text on moving geometry that tracks the footage, is `three-overlays`.

Captions are flat by default. Add depth or tilt only when the user explicitly asks for a 3D,
road or fly-through look. 2D in-plane rotation (`rotation`, Transform tab) is always safe. If
you are reproducing a source video's captions and cannot tell flat from 3D, `mimic-video-captions`
owns that call.

## Code overlay: the last resort

> STOP before `libi.add_overlay({ kind: "code" })` for text. If the reveal modes and style
> fields can express the look, use them. A code overlay is only for bespoke procedural motion:
> a custom kinetic path, a gradient shine you must draw, a multi-line stagger you must
> hand-tune. When you do write one, copy a tested body from `prompts/styles.md` and keep its
> pacing math; guessing whether `time` is overlay-local or composition-global is how the
> "Sa" bug happens.

A code overlay's draw function runs on element-local time: `progress` goes 0→1 across the
overlay's own window, `time` and `frame` start at 0 at its `startTime`, and `totalFrames` is its
own length. Pace every animation off `progress`, never off composition frames
(`prompts/timing-contract.md` has the context fields). Never hard-code a composition time in a
body: when it must know where it sits on the piece, use `compositionTime`, `overlayStart` or
`pieceDuration`, so retiming the overlay or the piece edits no code.

Matching an existing overlay's style: `libi.code_outline({ pieceId, overlayId })` lists its
functions, palette and fonts without running it. Outline first, read only the lines you will
reuse (`includeSource: { from, to }`), and never print a whole kit. To draw in that style, reuse the kit with
`include` on `libi.add_overlay` (`include: { fromOverlayId, names }`, or `libi.update_overlay` for an
overlay that exists): it copies just the helpers your body reads, and its result lists what it
copied and any `warnings` for a name still undefined. Don't copy a kit by hand.

1. Pick a style from `prompts/styles.md`, decide the window (`startTime`, `duration` in
   composition seconds), and fill the template's text, font and colour.
2. `libi.add_overlay({ pieceId, kind: "code", displayName, body, startTime, duration, rect,
   z })`. `displayName` is required (the timeline track label). It returns `codeFilePath`, the
   overlay's `draw.jsx`; refine the animation by editing that file directly. A watcher
   revalidates and updates the preview, and there is no code-string update tool.
3. Check the start, middle and end of the window, and that the full text shows by the end of
   the reveal.

## Guardrails

- The draw-function validator is regex-based and rejects bodies containing ` import `,
  `require(`, `eval(` and the like, even inside the displayed text. Rephrase the text, or use
  a static text overlay.
- Text does not wrap: a line wider than the canvas spills off both edges. Read `width` from
  `libi.get_composition` and keep `chars × 0.6 × fontPx ≤ 0.84 × width`; shrink the font or
  stack lines (`speech-captions`, `prompts/readability.md`).
- A caption that labels speech runs from the phrase's first word to after its last word (plus
  a short hold), with the end taken from the last word's timing, not a guessed duration
  (`speech-captions`, `prompts/timing-contract.md`).
- Over busy footage use a stroke or an opacity plate behind the text.
- One overlay per animated element: a multi-line template beats ten stacked code overlays.

When the user describes a specific look (font, colour, stroke, shadow), set it, and once it is
right offer to save it with `libi.caption_style({ action: "create" })` so it shows in the Style tab. Ask
first; never create styles unprompted.

When the result is not what they wanted, do not re-run blindly: point them at the governing
control and load `guiding-manual-edits`. Style and 3D fields can be flashed with
`libi.highlight_property`; the reveal itself lives in the Effects panel's Reveal tab, which you
name in chat.

Render and look before you tell the user it is done (`libi.render_overlay_frames`, see the
manual's "Putting results in front of the user").
