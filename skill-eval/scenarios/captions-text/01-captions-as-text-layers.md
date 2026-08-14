---
id: captions-text-as-text-layers
title: Captions are laid as multiple text overlays (one per cue with reveal), not one code overlay
skills: [speech-captions, audio-analysis]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
covers: [captions-text, speech-captions, add-overlay, text-overlay, reveal, one-per-cue, no-code-caption]
---

## Prompt
I have a piece open with a clip that has someone talking. Add captions synced to
what she's saying.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Read the spoken audio for word-level timings (local Whisper STT / the
  audio-analysis transcript path) and laid the captions as **structured text
  overlays** — MULTIPLE `libi.add_overlay({ kind: "text" })` calls, one per cue,
  each with its own `startTime` / `duration`.
- Set a `reveal` on each cue overlay (e.g. `reveal.mode` — cumulative /
  word-by-word / karaoke / typewriter) so the caption is time-synced text, not a
  static dump.
- Did NOT lay the whole caption track as a single `libi.add_overlay({ kind: "code" })`
  caption overlay (a hand-written JS draw function rendering all cues) — captions are
  per-cue structured text overlays, which stay click-to-edit and natively composite in
  the ffmpeg export.
- Cue count is plural and roughly tracks the spoken phrases (chunked to a readable
  handful of words per cue), in spoken order — not one overlay covering the entire
  clip.
- Did NOT generate a video/image to bake in the captions — they're overlays added in
  post.
