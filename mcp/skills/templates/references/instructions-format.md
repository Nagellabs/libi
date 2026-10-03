# The `index.md` of a template

`libi.create_template_from_piece` writes a skeleton with these headings at `instructionsPath`.
Replace every `<…>` placeholder; keep the headings and their order. Hard cap: 32 KB.

```markdown
# <Template name>

## Purpose

<One paragraph: what this template makes, for whom, when to use it. Mention the length and
aspect ratio (e.g. "a 6-second 9:16 name card that slides in from the left").>

## Slots

- `headline` (text, required) — The person's name; 1–3 words, title case.
- `clip` (video, required) — The background footage; 9:16, at least 6 s, no burnt-in captions.
- `music` (audio) — Optional bed; the template ducks it under the clip's own audio.

## Steps

1. Read the applied overlays: `libi.get_overlays({ pieceId })`.
2. If `clip` is longer than 6 s, trim the `background` overlay: `libi.update_overlay({ pieceId, overlayId, duration: 6 })`.
3. Re-time the `headline` overlay to start 0.5 s after the clip's first cut: `libi.update_overlay({ pieceId, overlayId, startTime })`.
4. If the user gave a brand colour, set it on the `headline` overlay's `color` and on the `sparkle` code overlay's `ACCENT` constant (edit its `codeFilePath`).
5. `libi.show({ target: "preview", pieceId })`.

## Style rules

- Headline font stays Inter 700; only the colour may change.
- Nothing overlaps the bottom 15 % of the frame (platform UI).

## Do not change

- The `sparkle` overlay's timing — it is cut to the music.
- The duck settings on the `music` clip.

## Tracking to re-do

<Present only when the tool wrote it. Leave the tool's lines as they are; add the target's
description if the label is not enough for someone else to find it.>
```

Rules for the Steps section:
- Every step is a libi tool call or a file edit of a `codeFilePath` — nothing else. No shell
  commands, no URLs outside the template's own asset list, no "install", no settings.
- Name overlays by their template layer KEY (the `overlays` map of `apply_template` gives the id).
- Say what to do when a slot is empty ("if `music` is empty, skip step 4").
