---
name: guiding-manual-edits
description: Point the user at the exact overlay inspector control instead of editing it for them — use when the user asks how to change something themselves, rejects your edit and wants to hand-tweak it, OR when your own automated refinements keep missing and the user would get there faster by hand. Drives `libi.highlight_property` (flash a field + reveal its tab) and `libi.set_complexity_mode` (switch one overlay's tab). Load when guiding a manual edit, NOT when the user wants you to make the change.
tags: [overlays, guidance, inspector]
---

# Guiding Manual Edits

When the user wants to make an overlay change **themselves** — "how do I make
this darker?", "I'd rather tweak the rotation by hand", or they reject an edit
you made and want to adjust it — do NOT silently re-edit the overlay. Point them
at the precise inspector control instead.

> **Your own edits feed this hand-off.** Route your OWN placements, transforms,
> and looks through the same controller keys you'd later highlight (per the base
> instruction's controllers-first default) — a value baked into a `code`/`three`
> body has no inspector field to target, so `highlight_property` can't reach it
> when the user wants to take over.

## Be proactive — offer the manual path when your refinements stall

Most users are NOT power-users and don't know these controls exist. A big part of
your job is teaching them — so don't only react when they ask. When the user asks
you to *refine* something and your automated attempts keep missing, **reason about
whether to keep trying or hand them the wheel**, and proactively offer the manual
path.

**Offer manual when:**

- You've genuinely tried once or twice and it's still "not quite" — diminishing
  returns from another round of `update_overlay`.
- The tweak is **subjective / taste-based** — an exact color or opacity, a
  precise position nudge, the *feel* of a font size or weight, a timing beat.
  Eyeballing a slider beats you guessing values blind.
- The user keeps coming back with "a bit more / less / not like that" — a sign
  the target lives in their head, not in a number you can infer.

**How to offer (warm + empowering, not a dismissal):** say plainly that this kind
of fine-tuning is quicker to dial in by hand, then point them at the exact control
and explain what to do — e.g. *"Color this precise is faster to nudge by eye than
for me to keep guessing — let me drop you right on the control."* Then call
`highlight_property` with a clear `note`, and walk through the steps in chat (what
the control does, which direction to drag, what "good" looks like).

**Stay reasoned — this is an OFFER, not a forced hand-off:**

- Don't bail on the **first** imperfect result — make a real attempt first.
- If the user clearly wants you to own it ("just keep trying", "you do it"), keep
  doing the work; don't push them into the editor.
- Use it when it genuinely empowers them, not as an escape hatch from hard work.

You usually DON'T need `set_complexity_mode` before highlighting —
`highlight_property` already reveals the field's tab. Reach for
`set_complexity_mode` only to pre-stage a whole tab on one overlay before
walking through several of its controls.

## How the inspector tabs work (read this — it changed)

Tabs are **INTENT GROUPS, not depth levels.** There are five groups:

- **Transform** — placement / size / 2D rotate / opacity / z-order / timing.
- **Style** — how it looks: color, background, stroke, shadow, reveal.
- **Text** — what it says + typography (content, font family/weight, alignment, size).
- **3D** — 3D extrusion (depth, tilt, bevel, colors, lighting) + the orbit
  gizmo's manual-angle accordion (Angle / Elevation / Spin / Z-depth).
- **Anchors** — tracked overlays only: the manual re-anchor management tab
  (list + jump / staged delete / re-track).

Each tab shows ONLY its own group's fields. Some fields have an in-group
**"Advanced ▾"** reveal for fine controls (e.g. z-order/timing, 3D side color),
but that's still the same tab. Pick the tab that holds the control you're
pointing at — `highlight_property` switches to it automatically.

**Which tabs a kind has** (a kind only shows tabs that have fields):

- **text (captions)** — all four: Transform, Style, Text, 3D.
- **image / video / code / three** — Transform + 3D (the flat kinds' 3D tab
  is gated by the `place3d` toggle; `three` is inherently 3D).
- **tracked** — Transform + Anchors (the Anchors tab hosts the manual
  re-anchor list — jump / delete / re-track; the drag-to-re-anchor gesture
  stays on the preview via "Adjust tracking").

The active tab is **per overlay** — every overlay remembers its own tab
independently. Switching one caption to Style does not touch any other
overlay. That's why `set_complexity_mode` takes an `overlayId`.

## The two tools

- **`libi.highlight_property({ pieceId, overlayId, property, note })`** — selects
  the overlay, switches THAT overlay's tab to the group holding the field, scrolls
  the control into view, and flashes it with your `note`. No edit is made — the
  user does the change.
  - `note` is a short, plain-language explanation shown next to the flashing
    control (keep it under ~200 chars).
- **`libi.set_complexity_mode({ pieceId, overlayId, mode })`** — switches ONE
  overlay's inspector tab to `transform`, `style`, `text`, `3d`, or `anchors`
  (tracked only). Because `highlight_property` already reveals the targeted
  field's tab, use this only to pre-stage a tab before guiding through
  *several* controls in it (e.g. switch a caption to `style` so the user can
  see color/background/stroke/shadow together). If the `mode` isn't a tab that
  kind has, the client clamps it to the kind's default tab.

**Rule:** if the intent is "you change it", use `update_overlay` (or edit the
code file). If the intent is "I'll change it, show me where", use
`highlight_property`.

## Valid `property` keys (per kind, per group)

These are the public inspector field keys, grouped by the **intent group (tab)**
each lives on **for that kind**. The **single source of truth** is
`lib/overlays/inspector-fields.ts` — a coverage test
(`__tests__/unit/overlays/inspector-fields-coverage.test.ts`) keeps this list in
lockstep with the rendered UI. If `highlight_property` rejects a key, it returns
the valid set. A key that exists for some OTHER kind but not this overlay's kind
now errors honestly (`property_not_applicable`, with the kind's valid keys)
instead of silently no-oping.

There is **no `group` (lane) key** — overlay lanes are assigned automatically by
the editor; the user changes a lane by dragging the track, not via an inspector
control.

The unified Transform panel replaces the old rect/rotation/flip keys (`position`,
`size`, `rotation`, `flipH`, `flipV`). For **every flat kind** (text, image,
video, code) the controls split across two tabs by plane:

- **Transform tab — in-plane (always on):** `transformPosX`, `transformPosY`,
  `transformSpin` (in-plane spin — writes `transform3d.rotation.z`), and
  `transformSize`. (Text is the one exception — it has NO `transformSpin`; its
  single in-plane spin control is the `rotation` ("Rotate") key, and its size IS
  `fontSize`, so text's Transform tab carries `rotation` + `transformPosX`/
  `transformPosY` but no `transformSpin`/`transformSize`.)
- **3D tab — out-of-plane (behind the `place3d` "Make it 3D" gate):** `place3d`
  (the boolean toggle), `transform3d.pose` (the Pose preset grid),
  `transform3d.rotation` (the rotation dial — Angle/Elevation/Spin circles +
  editable inputs), and `transformPosZ` (depth). These are surfaced directly on
  the 3D tab for ALL flat kinds — **no accordion** — and apply once `place3d`
  is on. Text adds its extrusion keys (`text3dEnabled`/`text3dDepth`/…) on the
  same tab.

  Size is `rect` (the base plane) for image/video/code/**three**, `fontSize`
  for text, and the uniform `scale` multiplier for tracked. A tilted/extruded 3D
  overlay's on-screen footprint can exceed its Size; that is a render-time
  projection, not a second size value. **`three` is a rect window:** the 3D scene
  renders INTO its `rect`, so resizing `rect` (the Size control) scales the
  apparent 3D content — exactly like image/video/code. There is no `scale` field.

**`place3d` — the "Make it 3D" gate (`update_overlay`-settable boolean):** set
`place3d: true` to put a flat overlay into 3D mode (the orbit gizmo appears and
the out-of-plane Angle/Elevation/Depth-Z controls take effect). Set
`place3d: false` to FLATTEN it — that zeros pitch/yaw + depth (and drops text
extrusion) so the overlay truly returns to plain 2D. The `place3d` toggle is the
ONE gate for entering/leaving 3D on a flat kind; the manual angle keys above only
have visible effect while it is on.

The `three` kind is inherently 3D (no `place3d` gate) and keeps its dedicated
`transform3d.*` gizmo keys. `tracked` has two tabs: Transform (fields below)
and Anchors (`trackAnchors` — the manual re-anchor management panel; target it
via `highlight_property`/`set_complexity_mode` with group `anchors`).

**text — Transform:** `rotation` (2D rotate / in-plane spin), `opacity`,
`zOrder`, `startTime`, `endTime`, `transformPosX`, `transformPosY`, `fontSize`
(Size mirror, bound to the same field as the Text tab's Size)
**text — Style:** `style`, `color`, `background`, `background.color`,
`background.padding`, `background.radius`, `stroke`, `shadow` (word reveal —
typewriter/karaoke/paint-on — is NOT an inspector field; it lives in the Effects
panel's **Reveal** family tab)
**text — Text:** `content`, `fontFamily`, `fontWeight`, `align`, `fontSize`
**text — 3D:** `place3d` (Make it 3D gate), `transform3d.pose` (the illustrated
**Pose** preset grid — snaps orientation to a recognizable pose),
`transform3d.rotation` (the rotation dial — Angle/Elevation/Spin circles +
editable degree inputs), `transformPosZ`, plus the extrusion
keys `text3dEnabled`, `text3dDepth` (labelled "Thickness"), `text3dBevel`,
`text3dFrontColor`, `text3dSideColor`, `text3dLighting`, and `transform.reset`
(the **Reset 3D** button). (Orientation is the unified Pose grid + dial — there
is no separate extrusion "Camera" grid anymore.)

**three — Transform tab:** `opacity`, `rotation` (in-plane Spin — writes
`transform3d.rotation.z`), `position`, `size` (Size — the rect window W/H, the
SAME generic control as image/video/code), `zOrder`, `flipH`, `flipV`,
`startTime`, `endTime`
**three — 3D tab:** `transform3d.pose` (the **Pose** preset grid),
`transform.reset`, `transform3d.rotation` (the rotation dial — Angle/Elevation/Spin),
`transform3d.position`

**image — Transform:** `opacity`, `zOrder`, `startTime`, `endTime`,
`transformPosX`, `transformPosY`, `transformSpin`, `transformSize`
**image — 3D (place3d gate):** `place3d`, `transform3d.pose`,
`transform3d.rotation`, `transformPosZ`

**code — Transform:** `opacity`, `zOrder`, `startTime`, `endTime`,
`transformPosX`, `transformPosY`, `transformSpin`, `transformSize`
**code — 3D (place3d gate):** `place3d`, `transform3d.pose`,
`transform3d.rotation`, `transformPosZ`

**video — Transform:** `opacity`, `transformPosX`, `transformPosY`,
`transformSpin`, `transformSize`
**video — 3D (place3d gate):** `place3d`, `transform3d.pose`,
`transform3d.rotation`, `transformPosZ`

**tracked — Transform:** `opacity`, `zOrder`, `startTime`, `endTime`,
`transformSpin`, `transformSize` (Size — the uniform `scale` multiplier on the
tracked art, shown as a percent; the SAME field the preview corner handles
write, so gizmo and inspector stay in sync), `offsetX`, `offsetY` (the follow
offset — reposition relative to the tracked subject without touching the
track; the preview drag writes the same field). There is NO
`transformPosX`/`transformPosY` for tracked — placement is track-driven;
reposition via the follow offset.
**tracked — Anchors:** `trackAnchors` (ONE key marking the whole manual
re-anchor management panel — the correction list with jump / staged delete /
re-track. It is not a value field; highlight it to point the user at the list.
The drag-to-re-anchor GESTURE itself stays on the preview via "Adjust
tracking".)

Umbrella keys (`background`) and their fine sub-keys (`background.color`,
`background.padding`, `background.radius` — all in the text Style group, with the
enable toggle) both exist — target the granularity that matches what the user
asked about.

**Point-text placement (text overlays, `update_overlay`-only):** `anchor`,
`position`, and `maxWidthPct` set a caption's placement directly — not via a
`highlight_property` field. `anchor` is one of the 9 anchor names (`top-left` …
`bottom-right`); `position` is the composition-pixel point that anchor pins to;
`maxWidthPct` (0..1 of frame width) caps the wrap. These are `update_overlay`
structured fields the agent sets when the user wants a caption re-placed — the
derived `rect` is recomputed on save, so preview and export stay in sync.

## Reusable overlay presets

When the user has tweaked an overlay's **look** and is happy with it, that look is
worth keeping. A preset captures the styling — color, font, stroke, shadow,
transform, animation, effects — and lets the user reuse it on another overlay
instead of re-dialing every value by hand.

- **A preset captures the LOOK, not the instance.** It stores the visual styling
  (color/font/stroke/transform/animation/effects), NOT per-instance fields — so
  the overlay's own text, position, and timing are never carried over.
- **Presets are KIND-SCOPED.** A text preset only applies to text overlays; an
  image preset only to image overlays. The list is filterable by `kind`.
- **Presets are GLOBAL across pieces.** They live under `~/.libi/overlay-presets/`,
  so a look saved while working on one piece is available on every other piece.
- **Bundled text style presets** (`clean`, `boxed`, `outline`, `pop`, `typed`)
  appear in the list alongside the user's own saved presets.

### The loop

1. **Offer to save after a good tweak.** Once the user likes an overlay's look —
   they say "perfect", or they stop asking for changes — proactively offer to keep
   it: *"Want me to save this look as a preset so you can reuse it on other
   captions?"* On yes:
   `libi.save_overlay_preset({ pieceId, overlayId, name })` → returns `{ presetId }`.
   Pick a short, descriptive `name` (e.g. `"gold-title"`, `"lower-third"`).
2. **Reuse a look on another overlay.** List what's available, then apply:
   `libi.list_overlay_presets({ kind })` → pick the preset →
   `libi.apply_overlay_preset({ pieceId, overlayId, presetId })`. The target
   overlay takes on the saved styling; its text/position/timing stay put.
3. **Remove a user preset** they no longer want:
   `libi.delete_overlay_preset({ presetId })`. (Bundled presets can't be deleted.)

**Prefer applying a preset over re-styling by hand.** If the user asks for a look
that matches an overlay you already styled — "make this one match the gold title"
— save the source's look once (if not already saved) and `apply_overlay_preset`
it, rather than re-setting every field on the second overlay manually.

## Worked examples

1. **Deeper / darker caption background.** User: "how do I make the caption's
   background darker myself?"
   → `libi.highlight_property({ pieceId, overlayId, property: "background.color", note: "Open the Background color swatch here and pick a darker / more opaque value." })`
   `background.color` lives in the text Style group, so that caption flips to its
   Style tab and the color control flashes — the user edits it.

2. **Rotate a 3D object.** User: "I want to spin this 3D title a bit, let me do
   it."
   → `libi.highlight_property({ pieceId, overlayId, property: "transform3d.rotation", note: "Use these Rot X/Y/Z fields to rotate the object." })`

3. **Pre-stage a tab, then point.** User: "show me the styling controls on this
   caption."
   → `libi.set_complexity_mode({ pieceId, overlayId, mode: "style" })`, then
   `libi.highlight_property({ pieceId, overlayId, property: "stroke", note: "Color, background, stroke, and shadow all live on this Style tab." })`
