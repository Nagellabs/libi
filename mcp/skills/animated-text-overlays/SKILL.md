---
name: animated-text-overlays
description: Add or FIX an ANIMATED text overlay — text that reveals or moves over time (typewriter / letter-by-letter, word-by-word fade, slide-up, pop, gradient shine, lower-third, kinetic hook / title / caption). Load this BEFORE hand-writing any code overlay (add_overlay kind code) that animates text — it owns the element-local timing contract that prevents the "only the first few letters show" reveal bug. Triggers — "make the caption type out", "animate the caption", "letter-by-letter typewriter", "kinetic hook", "the animated caption is broken / cut off". NOT for subtitles synced to speech (use speech-captions); NOT for plain static text (use add_overlay kind text).
tags: [overlays, text, animation]
---

# Animated Text Overlays (kinetic typography)

Use this when the user wants text that **animates** — "make the caption type
out", "animated hook", "make the title pop in", "word-by-word reveal" — **or
when you are about to add OR FIX a code overlay that animates text** (a
typewriter reveal, a kinetic caption, a broken/cut-off animated caption). For
plain static text use `libi.add_overlay({ kind: "text" })`. For subtitles synced to spoken
audio use the **`speech-captions`** skill. For a caption that needs real **depth /
perspective** — text mapped onto a road/floor, or 3D-positioned lyrics that play
with the footage (not a flat 2D treatment) — use the **`three-overlays`** skill
(real WebGL); this skill is for FLAT kinetic text only.

## Structured text first — declarative reveal + 3D, no code

A `kind: "text"` overlay is now declarative for BOTH motion and depth — prefer
it over a code overlay whenever it can express the look:

- **Reveal vocabulary** on `reveal.mode`: `typewriter`, `fade-words`,
  `slide-up`, `pop`, plus `karaoke` (full line, active word highlighted via
  `reveal.highlightColor`) and `word-current` (only the active word shows). The
  renderer paces these natively off the overlay's element-local window — no JS
  draw function to author or validate.
- **Declarative 3D** via the `threeD` field on `kind: "text"` (depth, bevel,
  front/side color, lighting, tilt) — flat decorative text that wants real
  extrusion stays `kind: "text"`, no WebGL code. Reach for the `three-overlays`
  skill only for ARBITRARY 3D scenes (objects, bespoke camera/perspective) that
  a single extruded text element can't express.

**Paint-on / fly-through caption.** For a caption that paints on across a 3D
plane (text sweeping in edge-on, "through the wall" perspective reveal), set
`reveal: { mode: "flythrough", direction }` on a `kind: "text"` overlay. This
mode REQUIRES `threeD` to be present (it's a 3D paint-on — enable extrusion
first). `direction` is one of `ltr` (left → right), `rtl` (right → left), or
`through` (sweeping toward/through the viewer). `sideOffset` tunes the profile
angle of the sweep — default `1.05`; smaller values are more edge-on (steeper
in-plane angle), larger flatter. Both are exposed on the text inspector's
Advanced tab (`reveal.direction`, `reveal.sideOffset`).

**Controllers-first (the hard default).** Satisfy the look by SETTING declarative
controller fields on a `kind: "text"` overlay — `reveal.mode` for motion, `threeD`
+ `place3d`/`transform3d` for depth/tilt, the style fields (`color` / `background` /
`stroke` / `shadow` / font) for the look — NOT by hardcoding it in a code body. A
field you set lands on the gizmo/inspector, stays tunable, and you can point the
user straight at it with `libi.highlight_property`. A look baked into a draw
function is none of those. (See the base instruction's "#### Overlay kind —
controllers-first (HARD DEFAULT)".) Reserve the code-overlay workflow below for
bespoke PROCEDURAL motion the reveal modes + style fields genuinely can't express
(custom kinetic paths, gradient shine, multi-line stagger you need to hand-tune).

## Captions are FLAT by default — go 3D only when the user asks for it.

**Default to flat 2D.** A caption is plain 2D — upright, centred, readable — unless
the user **explicitly** asks for a 3D / tilted / "road" / fly-through / lyric-on-the-
road look. "Add a caption that says X", "subtitle this", "put a kinetic hook on top",
"make the title pop in" are all FLAT — build them flat (here) or via `speech-captions`,
and do NOT enable depth/tilt. A flat caption is always upright and never edge-on; the
renderer guardrails this — a flat caption can't be tilted off-plane.

**When the user DOES ask for a 3D / tilted / perspective look** (real depth, a dolly-
toward-camera, text laid on a road or floor, world-anchored lyrics that recede with the
footage), enable 3D explicitly:
- For 3D *text* (extruded title, tilted lyric), set the `threeD` field on a
  `kind: "text"` overlay (`depth` + optional `tilt`/`bevel`/colors/lighting). This is
  the declarative 3D-text path — no WebGL code. In the inspector this is the **3D tab's
  "Make text 3D" opt-in** (`text3dEnabled`, off by default); **3D positioning (tilt /
  yaw / spin / orbit) is driven by the on-canvas orbit gizmo**, which appears only once
  a caption is 3D (numeric "Manual angles" live in a collapsed accordion for fine work).
- For an **arbitrary 3D scene** (bespoke camera/perspective, objects, text genuinely
  mapped onto a receding ground plane that `threeD.tilt` can't capture) → use the
  **`three-overlays`** skill (real WebGL).

**2D in-plane rotate is always safe.** Roll / 2D-rotate lives on the **Transform tab**
(`overlay.rotation`, degrees about the rect center) and never hides the text — use it
freely for a tilted-but-readable caption without touching 3D.

**Mimicking a stylized source caption?** If you're reproducing an existing video's
captions and genuinely can't tell flat-vs-3D from the source, the `mimic-video-captions`
skill owns that decision — it prefers a caption-focused analysis (which reports
`anchor`/`orientation`) and asks the user only when that's unavailable. Outside that
mimic flow, default flat.

> **STOP — do not hand-write the draw function.** If you are reaching for
> `libi.add_overlay({ kind: "code" })` to animate text (or to fix one that reveals
> only the first few letters), read this skill first and copy a tested body from
> `prompts/styles.md`. Hand-rolling the pacing math from scratch — guessing
> whether `time` is overlay-local or composition-global, dividing by
> `totalFrames`, re-deriving `progress` — is exactly how the "Sa" bug happens.
> The contract below removes the guessing: `progress` is already 0→1 across
> THIS overlay's window.

## The one rule that prevents the classic bug

A code overlay's draw function animates on **element-local time** — `progress`
goes 0→1 across the OVERLAY'S OWN window, `time`/`frame` are relative to the
overlay's `startTime`, and `totalFrames` is the overlay's own length. **Pace
every animation off `progress`, never off composition frames.** See
`prompts/timing-contract.md`. (Pacing off composition frames is exactly what
made a past typewriter reveal only "Sa" before vanishing.)

## Workflow

> **STOP — a code overlay is the LAST RESORT, not a co-equal path.** Before
> reaching for `libi.add_overlay({ kind: "code" })`:
> - For **3D / tilt / depth**, use `kind: "text"` + `place3d` + `transform3d` /
>   `threeD` — never a code body. (3D caption = `add_overlay({ kind: "text" })`
>   THEN `update_overlay({ place3d: true, transform3d })`.)
> - For **reveals**, use `reveal.mode` (`typewriter` / `fade-words` / `slide-up`
>   / `pop` / `karaoke` / `word-current`).
> - Reach for a code overlay ONLY for bespoke PROCEDURAL motion the reveal modes
>   + style fields genuinely cannot express (a custom kinetic path, a gradient
>   shine you must hand-draw, multi-line stagger you need to hand-tune).

**First, can the structured fields do it?** For a readable caption with a reveal,
the structured fields on `libi.add_overlay({ kind: "text" })`
(`background`, `stroke`, `shadow`, `threeD`, and `reveal: { mode }` —
`typewriter` / `fade-words` / `slide-up` / `pop` / `karaoke` / `word-current`)
are the cheap path: the renderer applies them natively, no JS draw function to
author or validate. `karaoke` and `word-current` cover the word-timed caption
styles too. Reserve the code-overlay workflow below for bespoke procedural motion
the reveal modes can't express.

1. **Pick a style** from `prompts/styles.md` (typewriter, fade-in-words,
   slide-up-lines, pop-scale-spring, gradient-sweep, lower-third).
2. **Decide the window**: `startTime` + `duration` (seconds, composition-global).
   The reveal completes within that window because it is paced off `progress`.
3. **Build the draw-function body** by filling the style's parameters (text,
   font, color, align, revealFraction). Copy the body shape from
   `prompts/styles.md` — these are the tested templates from
   `lib/engine/text-anim/templates.ts`; do not invent pacing math.
4. **Add it**: `libi.add_overlay({ pieceId, kind: "code", displayName, body, startTime,
   duration, rect, z })`. `displayName` is REQUIRED for code overlays — a short
   human name (e.g. `"Hook Caption"`) shown in the timeline track label. The rect is the overlay's box; the body draws in
   rect-local coordinates (`width`/`height` are the rect's size). The call returns
   `{ overlayId, codeFilePath }` — `codeFilePath` is the overlay's `draw.jsx` file.
   **To refine the animation afterward, EDIT that file directly with your file
   tools** (Read + Edit/Write); the storage watcher re-validates and live-updates
   the preview. There is no code-string update tool — code lives in the file.
   Rediscover an existing overlay's file with `libi.get_overlays`.
5. **Verify**: preview at `startTime`, `startTime + duration/2`, and
   `startTime + duration` (or ask the user to scrub). Confirm the FULL text is
   visible by the end of the reveal — never a truncated "Sa". Fix by editing the
   `draw.jsx` file again.

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

## Guardrails

- **Reserved words in text:** the draw-function validator is regex-based and
  rejects bodies containing ` import `, `require(`, `eval(`, etc. — even inside
  the displayed text. If the caption text contains such a word, rephrase it or
  fall back to `libi.add_overlay({ kind: "text" })` (static).
- **Fit the canvas width — text does NOT wrap.** A line wider than the canvas spills
  off both edges (`rect.width` only anchors, it never wraps/clips). Read `width` via
  `get_composition` and keep `chars × 0.6 × fontPx ≤ 0.84 × width`; shrink the font or
  split into stacked lines. See `speech-captions` `prompts/readability.md`.
- **Timing to speech — cover the full spoken phrase.** If a caption labels something
  being said, its window must run from the phrase's first word to **after** its last
  spoken word (+ ~0.3–0.5s hold) — set the END from the last word's timing, never a
  fixed guessed duration. A caption pulled mid-phrase reads as a glitch. See
  `speech-captions` `prompts/timing-contract.md`.
- **Readability over video:** for text over busy footage, prefer a style with a
  bar/stroke (`lower-third`) or add an opacity plate.
- **One overlay per animated element.** Don't stack ten code overlays when one
  multi-line template does the job.

## Offer to save a described look as a reusable style

When the user describes a specific text LOOK (a font + color + stroke + shadow
combination, a branded caption treatment), **set it** on the overlay AND, once
it's right, **offer (consent-first) to save it as a reusable style** via
`libi.create_caption_style` — it shows up in the **Style tab** for one-click reuse
on future captions. Ask before saving; don't create styles unprompted.

## When your own result isn't right

If the animation or look you produced isn't what the user wanted, **don't just
re-run blindly** — point them at the exact control. Use
`libi.highlight_property` to surface the field that governs the look they want to
change (e.g. `reveal.mode`, a `threeD` field, a style field), and lean on the
**`guiding-manual-edits`** skill to walk them through the hand-tweak in the
inspector. That keeps the result on the gizmo/inspector and tunable instead of
buried in a draw function.
