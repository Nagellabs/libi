---
id: speech-captions-styled-synced
title: Styled speech-synced captions for the first spoken sentence
skills: [speech-captions, audio-analysis]
mcps: []
agent: claude-code
runs: 1
covers: [captions, transcript, word-timings, caption-style, free-stt-first]
---

## Prompt
Caption only the first sentence the speaker says in this clip, synced to her
real speech timing. Pick a nice caption style that suits the content.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Loaded the `speech-captions` skill (not `animated-text-overlays`, not raw
  per-line text overlays).
- Transcribed the audio using **free local Whisper first** — did NOT call a paid
  STT provider (ElevenLabs or other) without explicit user approval.
- Read per-word timings from the RAW word array via
  `libi.analysis_get_audio_chunks` — did NOT reverse-engineer word boundaries
  from `libi.analysis_search_transcript` context windows.
- Built caption cues for **only the first sentence** (not the full clip).
- Converted absolute word timestamps to element-local seconds by subtracting
  the caption overlay's `startTime`.
- Chose a caption style (cumulative, word-by-word, karaoke, or letter-by-letter)
  and **stated the chosen style** in the final result message to the user.
- Built the captions as PER-CUE TEXT overlays — multiple `kind:"text"` overlays
  sharing one caption group + `reveal` (consistent with
  captions-text/01-captions-as-text-layers) over the first-sentence spoken
  window — with readability defaults (stroke outline, bottom-safe placement). Did
  NOT pack the sentence into a single caption code overlay, and did not
  double-render the same lines as static text.
