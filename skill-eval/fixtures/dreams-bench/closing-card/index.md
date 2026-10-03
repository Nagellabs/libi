# Closing card

## Purpose

A 4-second closing card for a video: a wordmark, a headline, a subline and a call to
action, over a dark backdrop with a logo in the corner. It is authored as a 16:9
(1920×1080) landscape card. Use it to end a video with where to watch or listen.

## Slots

- `headline` (text, required) — two to four words, title case.
- `subline` (text, required) — one short line under the headline.
- `cta` (text, required) — where to watch or listen.

## Steps

1. Read the applied overlays: `libi.get_overlays({ pieceId })`.
2. Move the layers so the card sits over the video's last 4 seconds.
3. `libi.show({ target: "preview", pieceId })`.

## Style rules

- The layers ship in the template's own colours; recolour them to suit the video.
- Nothing may leave the frame.

## Do not change

- The text of the `wordmark` layer.
