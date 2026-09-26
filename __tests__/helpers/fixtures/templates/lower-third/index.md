# Lower third

## Purpose

A 4-second 9:16 name card: the headline slides in over the background footage with a
small logo in the top-left corner. Use it to introduce a person at the top of a vertical
clip. The background is optional — with no clip the card sits on the empty canvas.

## Slots

- `headline` (text, required) — The person's name; 1–3 words, title case.
- `clip` (video) — The background footage; 9:16, at least 4 s, no burnt-in captions.

## Steps

1. Read the applied overlays: `libi.get_overlays({ pieceId })`.
2. If `clip` is longer than 4 s, trim the `background` overlay: `libi.update_overlay({ pieceId, overlayId, duration: 4 })`. If `clip` is empty, skip this step.
3. `libi.show_preview({ pieceId })`.

## Style rules

- Headline font stays Inter 700; only the colour may change.
- Nothing overlaps the bottom 15 % of the frame (platform UI).

## Do not change

- The `sparkle` overlay's timing — it is cut to the card's slide-in.
- The `logo` overlay's position.
