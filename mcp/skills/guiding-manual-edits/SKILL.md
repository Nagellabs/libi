---
name: guiding-manual-edits
description: "Point the user at the exact inspector control instead of changing it for them: they ask how to change something themselves, reject your edit and want to hand-tweak it, or your own refinements keep missing. Not for when the user wants you to make the change."
tags: [overlays, guidance, inspector]
---

# Guiding manual edits

Done looks like this: the user is looking at the one control that changes what they asked
about, with a plain-language note on what to do, and you have not edited the overlay behind
their back. If the intent is "you change it", use `libi.update_overlay` (or edit the code
file). If it is "I'll change it, show me where", use `libi.highlight_property`.

The hand-off only works if your own edits went through controller fields (`transform3d`,
`rect`, the style fields), as the base instructions say. A value baked into a `code` or `three`
body has no inspector field, so `highlight_property` cannot reach it.

## Offer the manual path when refinement stalls

Most users do not know these controls exist, so offer, do not only react. When your automated
attempts keep missing, decide whether to keep trying or hand them the wheel. Offer the manual
path when:

- you have genuinely tried once or twice and it is still "not quite";
- the tweak is taste-based: an exact colour or opacity, a position nudge, the feel of a size,
  weight or timing beat, where eyeballing a slider beats guessing values;
- the user keeps saying "a bit more / less / not like that", a sign the target lives in their
  head and not in a number you can infer.

Say plainly that fine-tuning like this is quicker by hand ("a colour this precise is faster to
nudge by eye; let me drop you on the control"), call `highlight_property` with a clear `note`,
and explain in chat what the control does and which way to move it. It is an offer, not a
hand-off: make a real attempt first, and if the user says "you do it", keep working.

## The two tools

- `libi.highlight_property({ pieceId, overlayId, property, note })` selects the overlay,
  switches that overlay's tab to the group holding the field, scrolls to it and flashes it
  with your `note` (under about 200 characters). It edits nothing. On a bad key it returns the
  valid set; a key that exists only for another overlay kind returns `property_not_applicable`
  with this kind's keys.
- `libi.set_complexity_mode({ pieceId, overlayId, mode })` switches one overlay's inspector tab
  (`transform`, `style`, `text`, `3d`, `anchors`). Highlighting already reveals the right tab,
  so use it only to pre-stage a tab before walking through several of its controls.

## Inspector keys

Tabs are intent groups, not depth levels. Transform is placement, size, 2D rotate, opacity,
z-order and timing; Style is how it looks; Text is content and typography; 3D is extrusion and
the orbit gizmo's manual angles; Anchors (tracked only) is the manual re-anchor list. Each
overlay remembers its own tab. The source of truth is `lib/overlays/inspector-fields.ts`; a
coverage test keeps this list in step with the rendered UI.

| Kind | Tab | Keys |
| --- | --- | --- |
| text | Text | `content`, `fontFamily`, `fontWeight`, `align` |
| text | Style | `style`, `color`, `background`, `background.color`, `background.padding`, `background.radius`, `stroke`, `shadow` |
| text | Transform | `fontSize` (text's size), `rotation`, `opacity`, `zOrder`, `startTime`, `endTime`, `transformPosX`, `transformPosY` |
| text | 3D | `place3d`, `transform3d.pose`, `transform3d.rotation`, `transformPosZ`, `text3dEnabled`, `text3dDepth`, `text3dBevel`, `text3dFrontColor`, `text3dSideColor`, `text3dLighting`, `transform.reset` |
| image, code | Transform | `opacity`, `zOrder`, `startTime`, `endTime`, `transformPosX`, `transformPosY`, `transformSpin`, `transformSize` |
| video | Transform | `opacity`, `transformPosX`, `transformPosY`, `transformSpin`, `transformSize` |
| image, video, code | 3D | `place3d`, `transform3d.pose`, `transform3d.rotation`, `transformPosZ` |
| three | Transform | `size` (the rect window), `opacity`, `rotation` (in-plane spin), `position`, `zOrder`, `flipH`, `flipV`, `startTime`, `endTime` |
| three | 3D | `transform3d.pose`, `transform3d.rotation`, `transform3d.position`, `transform.reset` |
| tracked | Transform | `opacity`, `zOrder`, `startTime`, `endTime`, `transformSpin`, `transformSize` (uniform scale), `offsetX`, `offsetY` (follow offset) |
| tracked | Anchors | `trackAnchors` (the whole re-anchor panel, not a value) |

What the less obvious keys do:

- `place3d` is the single "Make it 3D" gate for flat kinds: the angle, elevation and depth
  controls take effect only while it is on. Setting it false flattens the overlay (zeroes
  pitch, yaw and depth, drops text extrusion). `three` is inherently 3D and has no gate.
- `transform3d.pose` is the Pose preset grid, `transform3d.rotation` the Angle / Elevation /
  Spin dial, `transform.reset` the Reset 3D button.
- Size is `rect` for image, video, code and three (resizing a three overlay's rect scales its
  3D content; it has no scale field), `fontSize` for text, and the uniform scale for tracked.
- A tracked overlay has no `transformPosX` / `transformPosY`: placement is track-driven, so use
  the follow offset.
- `background` is the umbrella (with its enable toggle); `background.color`, `.padding` and
  `.radius` are the fine keys. Target the granularity the user asked about.
- Text reveal (typewriter, karaoke, paint-on) is not an inspector key; it lives in the Effects
  panel's Reveal tab, so name that tab in chat. Effects themselves can be flashed with
  `libi.highlight_effect`.
- There is no lane key: the user changes a lane by dragging the track. Point-text placement
  (`anchor`, `position`, `maxWidthPct` on a text overlay) has no inspector field either; set it
  with `update_overlay`.

## Presets

When the user is happy with an overlay's look, offer to keep it ("save this look as a preset
so you can reuse it on other captions?"). A preset stores the styling (colour, font, stroke,
shadow, transform, animation, effects), never the instance's text, position or timing. Presets
are scoped to an overlay kind and shared across pieces; bundled text presets (`clean`,
`boxed`, `outline`, `pop`, `typed`) appear alongside the user's own.

- `libi.overlay_preset({ action: "save", pieceId, overlayId, name })` returns `{ presetId }`; use a short
  descriptive name.
- `libi.overlay_preset({ action: "list", kind })`, then `libi.overlay_preset({ action: "apply", pieceId, overlayId,
  presetId })` to reuse a look. Prefer applying a preset over re-setting every field by hand
  when the user says "make this one match the gold title".
- `libi.overlay_preset({ action: "delete", presetId })` removes a user preset; bundled ones cannot be
  deleted.

## Example

"How do I make the caption's background darker myself?" becomes `libi.highlight_property({
pieceId, overlayId, property: "background.color", note: "Open the Background colour swatch and
pick a darker, more opaque value." })`. The caption flips to its Style tab and the control
flashes; the user makes the change.
