---
id: speech-captions-synced
title: Captions synced to spoken audio from the transcript
skills: [speech-captions, audio-analysis]
mcps: []
agent: claude-code
runs: 1
covers: [captions, transcript, element-local-timing, readability, caption-width-fit, caption-covers-full-phrase]
---

## Prompt
Add captions to this talking-head clip, synced to what she's saying.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Loaded the `speech-captions` skill (not `animated-text-overlays`, not a raw
  text overlay per line).
- Sourced timed text from a transcript (video-analysis / audio-analysis) OR
  explicitly fell back to evenly-timed chunks and SAID sync is approximate.
- Built per-cue timing in element-local seconds (relative to each caption
  overlay's startTime), not absolute composition timestamps.
- Built the captions as PER-CUE TEXT overlays — multiple `kind:"text"` overlays
  sharing one caption group + `reveal` (consistent with
  captions-text/01-captions-as-text-layers), one overlay per spoken phrase over
  the spoken window — with readability defaults (stroke/plate, bottom-safe). Did
  NOT pack the whole transcript into a single caption code overlay, and did not
  double-render the same lines as static text.
- **Sized captions to the canvas width.** Read the composition `width` (did NOT
  assume 1080p) and kept each line within the no-wrap width budget
  (`chars × 0.6 × fontPx ≤ 0.84 × width`), splitting a long cue into ≤2 stacked
  lines rather than letting one line overflow the (vertical 9:16) frame. A plan
  that picks a flat ~32-char cue at a large font on a narrow canvas — the bug that
  shipped captions spilling off both edges — is a miss.
- **Each caption covers its full spoken phrase + a hold.** Computed every cue/caption
  END from the phrase's LAST word `end` (from `analysis_audio_chunks.words[]`), not a
  fixed guessed duration — `end ≥ lastWordEnd` plus a ~0.3–0.5s hold — so no caption
  is pulled while the words are still being spoken. A caption that clears mid-phrase
  (e.g. a headline ending at 5.0s while she finishes the word at 5.66s) is a miss.
- **Anchored the START to the actual first transcribed word — no early start.** Set
  `start ≈ firstWordStart − ~0.15s` (and never before the prior phrase's last word),
  matching the phrase to the transcript by position, NOT exact spelling. Did NOT treat
  a Whisper mis-transcription ("Chipped"→"Chips") as a dropped word and back-calculate a
  phantom earlier start — a caption appearing 0.5–0.7s before she speaks it (or over the
  previous sentence) is a miss.
