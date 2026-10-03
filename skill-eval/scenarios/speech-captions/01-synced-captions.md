---
id: speech-captions-synced
title: Captions synced to spoken audio from the transcript, then a text edit
skills: [speech-captions, audio-analysis]
mcps: []
agent: claude-code
runs: 1
# Same route as the sibling 02 — transcribe, then build one text overlay per cue —
# over the WHOLE clip rather than one sentence, so strictly more work. 02 was cut at the
# 300 s default mid-flow (2026-09-10 QA); this is the caption-family tier used by
# `captions-text/01` and `file-based-overlays/01`.
timeoutSec: 1200
# Local Whisper needs `uv` and the weights; without them the run stops at needs_install and
# never reaches a caption (the voice-replacement/01 precedent). A COPY, never a link.
share: [bin, models]
# The shared transcription fixture (whisper.cpp's samples/jfk.wav, 11 s, one speaker —
# __tests__/fixtures/audio/jfk.SOURCE.md). The only committed media with real speech.
fixtures: [__tests__/fixtures/audio/jfk.wav]
covers: [captions, transcript, element-local-timing, readability, caption-width-fit, caption-covers-full-phrase, caption-windows, caption-text-edit, AUD-1, AUD-2]
---

> **2026-09-27: it now has speech to caption.** Until today the prompt said "this
> talking-head clip" and declared no `fixtures:`; the harness's piece is EMPTY, so every run
> (two in the 2026-10-02 FINAL gates) found nothing to caption and passed as NO-ASSERTIONS.
> The fixture is `jfk.wav` — audio only (no committed clip carries speech, and this adds no
> binary), so the captions sit over an empty 9:16 canvas; nothing here depends on footage.
>
> **What the needles hold (week 2026-10-02).**
> - **AUD-1 — caption windows.** `generate_captions` builds cues only inside the windows where
>   the file is HEARD on the timeline, shifting source-time words onto timeline time. The
>   prompt places the recording 2 s into the piece, so every cue id
>   (`cue-cap-<fileId>-w<n>-<startMs>`) must start at ≥ 2000 ms: a cue below that was built from
>   raw source time (the no-window fallback), not from the clip's window. `cueCount ≥ 1` guards
>   the other way — an audible clip counted as silent makes 0 cues and a hint.
> - **AUD-2 — the edit note.** The scripted reply changes one word into two, so the edited cue's
>   spoken-word count changes and `update_overlay` re-spreads its word timings and says so in a
>   result `note`. The agent must relay that, and must not "fix" it by re-running
>   `generate_captions` — which would replace the track and throw the user's edit away.
> - Tolerant of the route: the transcript may come from `analysis_transcribe_audio` or an
>   existing analysis (`libi.analysis_query` action `get` / `audio_chunks`); `audio_add_clip` or any
>   other way of putting the file at 2 s is fine.

## Prompt
Upload the voice recording {{fixture:jfk.wav}} to this piece and put it on the timeline
starting 2 seconds in (I want a beat of silence first). Then add captions synced to what he's
saying.

## Replies
1. In the caption where he says "Americans", change that word to "American citizens".

## Hard invariants
```yaml
assertions:
  # A local transcript was made or reused (generate_captions refuses without one).
  - { transcript_contains: ["[tool-call mcp__libi__libi_analysis_transcribe_audio]", "[tool-call mcp__libi__libi_analysis_query]"], turn: 1, expect: present }
  # AUD-1: the track was built in one generate_captions call and the heard clip made cues.
  - { transcript_contains: "[tool-call mcp__libi__libi_generate_captions]", turn: 1, expect: present }
  - transcript_matches: '\\"cueCount\\":[1-9]'
    turn: 1
    expect: present
  # AUD-1 windows: cues follow the clip's timeline window (starts at 2 s), never raw source time.
  - transcript_matches: 'cue-cap-[0-9a-f-]+-w\d+-(?:[2-9]\d{3}|\d{5,})'
    expect: present
  - transcript_matches: 'cue-cap-[0-9a-f-]+-w\d+-(?:\d{1,3}|1\d{3})(?!\d)'
    expect: absent
  # AUD-2: the edit went through update_overlay and its result carried the re-spread note…
  - transcript_matches: '\[tool-call mcp__libi__libi_update_overlay\] \{[^\n]*"content":"[^"\n]*American citizens'
    turn: 2
    expect: present
  - transcript_matches: '\\"note\\":\\"The edited caption has different words'
    turn: 2
    expect: present
  # …which the user heard about (the timings were spread, the highlight may run off)…
  - { transcript_contains: ["spread", "slightly off", "off the speech", "timing", "Timing"], turn: 2, scope: agent_text, expect: present }
  # …and the edit was kept: re-running generate_captions would replace the track and drop it.
  - { transcript_contains: "[tool-call mcp__libi__libi_generate_captions]", turn: 2, expect: absent }
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
