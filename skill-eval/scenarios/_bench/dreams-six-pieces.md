---
id: bench-dreams-six-pieces
title: "Speed benchmark: the same audio + retime edit across a folder of six duplicate pieces"
skills: ["*"]
mcps: []
agent: claude-code
runs: 2
timeoutSec: 3600
hooks: skill-eval/scenarios/_bench/dreams-six-pieces.hooks.ts
fixtures:
  - skill-eval/fixtures/dreams-bench/intro-clip-12s.mp4
  - skill-eval/fixtures/dreams-bench/tidewater-lights-30s.m4a
  - __tests__/fixtures/audio/jfk.wav
covers: [benchmark, agent-speed, multi-piece-edit, ripple-retime, music-bed, ducking, audio-rights]
---

# Speed benchmark — the Dreams session, condensed

The point of this scenario is its NUMBERS, not its verdict: tool calls by tool, API turns,
input / cache-read / cache-write / output tokens, wall time and cost per run. The harness
copies the inner agent's session log into `<reportDir>/agent-jsonl/` and writes
`metrics.json`; `npx tsx scripts/skill-eval/bench-metrics.ts <runsDir>` prints the per-run
table and the medians. Baselines and method: `docs-local/research/2026-10-03-speed-benchmark.md`.

Modelled on the 2026-10-02 "Dreams × Ocean Spray — 6 styles" session (439 calls, 191 API
turns, 55.7M cache-read, ~$17.5 — `docs-local/research/2026-10-03-dreams-session-analysis.md`),
where 57% of the calls repeated one edit across six duplicate pieces and ~100 went into
inserting 3 s by hand. The seed hook (`dreams-six-pieces.hooks.ts`) rebuilds that shape through
libi's own routes and tools: a folder of six 9:16 duplicates sharing every overlay and clip id —
a 5 s intro video (with its own sound) cut from a 12 s clip, an 11 s narration from 5.3 s, a
caption over it (a different colour per piece), a code end card at 16.5–20.5 s, and a 30 s song
in each piece's files, stamped copyrighted with a track title, not on the timeline. The three
user turns are the session's first two requests and its verification, condensed.

The `verify` hook checks OUTCOMES on all six pieces — never a tool sequence, and only what
today's tools can express: intro 5 → 8 s with the narration, caption and end card each moved
+3 s; the song audible from the intro's end (±0.5 s) to the piece's end; ducked under the
narration (a duck keyed on the narration clip, or a bed at most 0.7× the end-card level);
over the end card no quieter than under the narration, and at ≥ 0.9. The level model is
volume × the duck's full reduction while a sidechain clip plays; fades are ignored (the
end-card probe sits 1 s into the card).

Fixture media: `jfk.wav` (11 s speech, shared with the captions scenarios) and two files
generated with ffmpeg from lavfi sources (`-map_metadata -1 -fflags +bitexact`):
`intro-clip-12s.mp4` (360×640 testsrc2, 30 fps, a modulated 330 Hz tone) and
`tidewater-lights-30s.m4a` (an A-major chord with a pulse and a kick).

## Prompt

For every piece in the "{{seed:folder}}" folder: play the music under the whole video after the intro, ducked under the narration, and make the intro 3 seconds longer.

## Replies

1. Bring the music back to full volume over the end card.
2. Check all six and tell me they're right.

## Behavioral expectations

- Applies the edit to all six pieces without asking the user to pick one first.
- Moves everything after the intro by 3 s rather than overlapping or cutting it.
- Uses the song that is already in each piece; does not download or generate music.
- In the last turn, reports per piece from what it read back, not from memory of its edits.
