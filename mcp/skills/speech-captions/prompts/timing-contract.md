# Caption timing contract

Each cue is its OWN structured text overlay. The overlay's `startTime` /
`duration` define WHEN it's on screen; the `reveal.mode` paces per-word emphasis
WITHIN that window off **element-local** time:

- `time` = seconds since the overlay's `startTime` (0 at the cue's first spoken
  word when you set `startTime` to the cue's start).
- The overlay is on screen for exactly `[startTime, startTime + duration)`.
  Outside that window it draws nothing — so the silence between cues, and after
  the last cue, shows no caption automatically.

Put **absolute (source-relative) seconds** in each cue overlay's `startTime` and
`duration`. The renderer remaps composition time into the overlay's own local
window for the reveal — you do NOT pre-subtract or supply per-word offsets.

One overlay per cue, in spoken order. Do not pack every cue into a single
overlay, and do not put absolute composition timestamps anywhere except the
overlay's own `startTime`/`duration`.

## Cover the full spoken phrase + hold (HARD)

A caption — whether a synced cue overlay OR a static `add_overlay (kind "text")`
headline you're timing to speech — must stay on screen for the **entire phrase
it labels, then a small hold**. It must NEVER be pulled while the words are still
being spoken.

- Read the phrase's word-level timings from `analysis_audio_chunks.words[]` (each
  word has `start`/`end`). Take `firstWordStart` and `lastWordEnd` for the phrase.
- **Anchor to the ACTUAL first transcribed word — never invent an earlier start.**
  Match the phrase to the transcript by **position**, not exact spelling: Whisper
  routinely mis-hears words ("Chipped"→"Chips", "MoYou"→"Moyu"). The first
  transcribed word IS your `firstWordStart` even if its spelling differs from your
  caption text. Do NOT treat a mis-spelled/abbreviated word as a "dropped" word and
  back-calculate an earlier start — that put a "Chipped nails" headline at 2.0s
  while she doesn't start saying it until 2.70s (0.7s early, overlapping the prior
  sentence).
- **start** = `firstWordStart − ~0.15s` lead (reads as "on time", not late), and
  **never earlier than the previous phrase's last word `end`** — a caption must not
  appear while the prior sentence is still being spoken. So
  `start = max(prevPhraseLastWordEnd, firstWordStart − 0.15)`.
- **end** = `lastWordEnd + ~0.3–0.5s` hold. The end is computed from the LAST
  word's `end`, NEVER a fixed guessed duration. So
  `duration = end − start`.
- A fixed 2–3s duration that ignores how long the phrase actually takes is the
  bug: a headline reading "Chipped nails are not cute" pulled at 5.0s while she
  finishes "cute" at 5.66s disappears ~0.5s early and reads as a glitch.
- **Verify BOTH edges on the read-back:** `start ≈ firstWordStart` (within the
  ~0.15s lead, and ≥ the previous phrase's last-word end) AND `end ≥ lastWordEnd`.
  A caption that appears before its first spoken word (or while the prior sentence
  is still going) is as wrong as one that vanishes mid-phrase — fix both.
- A stacked multi-line caption (line 1 + line 2 of one phrase) shares ONE window —
  add both line overlays with the SAME `startTime`/`duration` so they appear and
  clear together across the whole phrase.
