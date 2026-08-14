# Caption styles → reveal modes

Captions are **structured text overlays** — one `libi.add_overlay({ kind:
"text" })` per cue. You do NOT author a draw function; you set the cue's
`content` + window + a `reveal.mode`. The renderer paces per-word emphasis off
the overlay's own element-local time, so word timing follows the overlay's
`startTime`/`duration` automatically.

Pick ONE style and pass its `reveal.mode`:

| Style | `reveal.mode` | Notes |
|---|---|---|
| **cumulative** *(default)* | `fade-words` | Words fade/rise in one after another and hold — most readable "follow along". |
| **word-by-word** | `word-current` | Only the active word of the cue shows, replaced as time advances. |
| **karaoke** | `karaoke` | Full cue shown the whole window; active word emphasized in `reveal.highlightColor`. |
| **letter-by-letter** | `typewriter` | Character-by-character reveal over the cue window. |

## Example — one cue (cumulative)

```
libi.add_overlay({
  pieceId,
  kind: "text",
  content: "Salon nails at home",
  startTime: 12.25,            // absolute seconds (firstWordStart − ~0.15 lead)
  duration: 1.7,              // cue.end − cue.start (covers the phrase + hold)
  rect: { x: 0.5, y: 0.84, w: 0.9, h: 0.12 },  // bottom-safe; same rect for every cue
  z: 50,
  reveal: { mode: "fade-words" },
  stroke: { color: "rgba(0,0,0,0.85)", width: 8 }  // OR a background plate
})
```

## Per-style reveal config

- **cumulative** → `reveal: { mode: "fade-words" }`
- **word-by-word** → `reveal: { mode: "word-current" }`
- **karaoke** → `reveal: { mode: "karaoke", highlightColor: "#ffd400" }`
- **letter-by-letter** → `reveal: { mode: "typewriter" }`

## Readability (always)

Set a stroke outline OR a background plate so captions read over bright and dark
footage, and size `fontSize` to the canvas width (see `readability.md`). Add one
overlay per cue, in spoken order — never one overlay holding all cues, and never
two overlays for the same line.
