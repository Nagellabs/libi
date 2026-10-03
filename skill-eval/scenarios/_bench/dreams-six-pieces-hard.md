---
id: bench-dreams-six-pieces-hard
title: "Speed benchmark (hard): retime, mix, restyle and verify a folder of six duplicate pieces with code captions, style kits and a 16:9 template"
skills: ["*"]
mcps: []
agent: claude-code
runs: 2
timeoutSec: 5400
hooks: skill-eval/scenarios/_bench/dreams-six-pieces-hard.hooks.ts
fixtures:
  - skill-eval/fixtures/dreams-bench/intro-clip-12s.mp4
  - skill-eval/fixtures/dreams-bench/tidewater-lights-30s.m4a
  - __tests__/fixtures/audio/jfk.wav
templates:
  - skill-eval/fixtures/dreams-bench/closing-card
covers: [benchmark, agent-speed, multi-piece-edit, ripple-retime, code-overlay-timing, style-kit, template-reflow, music-bed, ducking, render-verify]
---

# Speed benchmark, hard variant — the Dreams session with its expensive parts kept

`dreams-six-pieces.md` is the light benchmark: fan-out and ripple-insert, nothing else. This one
adds what the real 2026-10-02 session spent most of its context on and the light one leaves out
(`docs-local/research/2026-10-03-dreams-session-analysis.md` §P2–§P6; write-up and how to run:
`docs-local/research/2026-10-03-speed-benchmark.md`, "Hard variant"). Read the NUMBERS, not the
verdict: `npx tsx scripts/skill-eval/bench-metrics.ts <runsDir>`.

The seed (`dreams-six-pieces-hard.hooks.ts`, bodies in `dreams-six-pieces-hard.kit.ts`) builds a
folder of six 9:16 duplicates sharing every overlay and clip id:

- a 5 s intro video with its own sound, an 11 s narration at 5.3 s (speech from `jfk.wav`);
- a **code caption** over the narration that shows one word at a time, with every word's timing
  **hard-coded in composition seconds** (the real `NARRATION_OFFSET = 8.3`): moving the narration
  and the caption leaves the words lagging by the move, unless the body is edited — or reads
  composition time where the runtime offers it;
- a **~190-line style kit** in the end card's code body (palette, fonts, common helpers, five
  style-specific helpers, a scene), different in every piece: reading one piece's kit teaches
  nothing about another's;
- a 30 s song in each piece's files, stamped copyrighted, off the timeline;
- the **"Closing card" template**, authored for 16:9 (1920×1080): three text slots, a wordmark
  with a rect keyframe, a backdrop and a logo; its layers land at time 0, partly off the 9:16
  frame, in colour `#E63946` — which belongs to no piece's palette.

The `verify` hook checks OUTCOMES on all six pieces, never a tool sequence:

- intro 5 → 8 s with the narration and the end card +3 s, and the intro's own sound with it;
- the caption still shows each of the 22 words within 0.09 s of the narration's word times — the
  hook RUNS the caption body at word edges with a recording canvas and reads what it drew;
- the song audible from the intro's end to the piece's end, 10 dB (±1.5) under the narration
  relative to its level over the end card, which is ~0 dB (−1 … +3 dB). Level = the manifest's
  effective gain: volume × `gainDb` × the volume envelope, times the duck's reduction while its
  sidechain clip plays; fades and crossfades are ignored and the probes sit away from edges;
- the closing card applied once with the asked text, every layer (keyframed rects included)
  inside the 9:16 frame, over the end card's window, every text layer in a colour of THAT
  piece's palette;
- the caption and end-card bodies run without throwing, and a real render of two frames per
  piece (`/api/render/frames`) reports no render diagnostics.

Fixture media: as the light benchmark (`jfk.wav`, `intro-clip-12s.mp4`, `tidewater-lights-30s.m4a`)
plus the template folder `skill-eval/fixtures/dreams-bench/closing-card/` (two generated PNGs, 40 KB).

## Prompt

For every piece in the "{{seed:folder}}" folder: make the intro 3 seconds longer. Everything after it moves with it, and the captions must stay in sync with the narration.

## Replies

1. Now play the song under each whole video after the intro. Keep it 10 dB quieter than its full level while the narration speaks, and back at full level over the end card.
2. Each piece needs a closing card. Apply the "Closing card" template to the end of every piece in the folder, over the end card, in that piece's own style: use that piece's colours and look. Headline "Out now", subline "Tidewater Lights · The Bench Band", call to action "Listen on every platform".
3. Check all six visually and tell me they're right.

## Behavioral expectations

- Applies each edit to all six pieces without asking the user to pick one first.
- Moves everything after the intro by 3 s rather than overlapping or cutting it, and fixes the caption's word timings instead of leaving the words 3 s late.
- Uses the song that is already in each piece; does not download or generate music.
- Reads each piece's own end card to learn its style; does not paste one piece's palette onto another.
- Reflows the 16:9 template into the 9:16 frame (rects and the keyframed wordmark), and puts it over the end card rather than at the start of the piece.
- In the last turn, looks at rendered frames of every piece and reports per piece from what it saw, not from memory of its edits.
