---
id: speech-captions-styled-synced
title: Styled speech-synced captions for the first spoken phrase, then a one-word edit
skills: [speech-captions, audio-analysis]
mcps: []
agent: claude-code
runs: 1
# Was the 300 s default and TIMED OUT there on 2026-09-10 with 152 KB of coherent,
# non-looping transcript — upload -> dimensions -> transcribe -> install plan ->
# whisper_download_model -> update_dep_status, still progressing when the axe fell. The
# transcription leg alone is a model-install path; 1200 s is the tier `captions-text/01`
# and `file-based-overlays/01` already carry for structurally comparable caption work.
timeoutSec: 1200
# Local Whisper needs `uv` and the weights (see speech-captions/01). A COPY, never a link.
share: [bin, models]
fixtures: [__tests__/fixtures/audio/jfk.wav]
covers: [captions, transcript, word-timings, caption-style, free-stt-first, caption-windows, caption-text-edit, AUD-1, AUD-2]
---

> **2026-09-27: it now has speech to caption.** Like `01`, this said "this clip" with no
> `fixtures:`, so the EMPTY piece gave the agent nothing to caption and both FINAL-gate runs
> were NO-ASSERTIONS. The fixture is `jfk.wav` (audio only, 11 s; see `01`). Its words are
> "And so, my fellow Americans, ask not what your country can do for you, ask what you can do
> for your country" — ONE sentence, so "the first sentence" would be the whole recording and
> the "only the first" bullet could not fail. The prompt now asks for his first PHRASE (what
> he says before his first pause, ≈0.4–2.3 s, a ~1.1 s gap before "ask not"), which keeps the
> scenario's "caption a part, not the whole clip" intent.
>
> **What the needles hold (week 2026-10-02).** Same features as `01`, the other branch of each:
> - **AUD-1:** the recording starts at 0, the heard clip makes cues (`cueCount ≥ 1`).
> - **AUD-2:** the scripted edit swaps one word for ONE word, so the spoken-word count is
>   unchanged: `update_overlay` keeps every word timing, replaces the words, and adds NO note.
>   `01` holds the re-spread branch (count changed → note). An agent that invents a timing
>   caveat here, or regenerates the track, is wrong in the opposite direction.
> - The chosen style is named to the user (a hard needle for the old behavioural bullet) —
>   one of the skill's four reveal styles or a bundled look from `list_caption_styles`.
> - "let the piece grow to fit it" is in the prompt because the first run (2026-09-27) stopped
>   turn 1 to ask extend-or-trim: `audio_add_clip`'s `lengthPolicy` text says to ask whenever
>   a clip would end past the piece's end, and does not say an EMPTY piece is exempt (the code
>   exempts it). The scripted reply cannot answer an unplanned question, so the prompt states
>   the answer; `01` never hit it.
> - Tolerant of the route: `generate_captions` then removing the cues after the phrase, or
>   the manual per-cue `add_overlay` fallback, both pass; so does reusing an existing
>   transcript. Only cue creation through `generate_captions` shows `cueCount`, so that
>   needle is an any-of with a text overlay added by hand.

## Prompt
Upload the voice recording {{fixture:jfk.wav}} to this piece and put it on the timeline from
the start, whole — let the piece grow to fit it. Caption only the first phrase he says — everything before his first pause — synced
to his real speech timing. Pick a nice caption style that suits the content.

## Replies
1. In that caption, change the word "Americans" to "citizens".

## Hard invariants
```yaml
assertions:
  # A local transcript was made or reused.
  - { transcript_contains: ["[tool-call mcp__libi__libi_analysis_transcribe_audio]", "[tool-call mcp__libi__libi_analysis_get]", "[tool-call mcp__libi__libi_analysis_get_audio_chunks]"], turn: 1, expect: present }
  # AUD-1: the heard clip made cues (generate_captions), or the cue was built by hand.
  - transcript_matches: '\\"cueCount\\":[1-9]|\[tool-call mcp__libi__libi_add_overlay\] \{[^\n]*"kind":"text"'
    turn: 1
    expect: present
  # The style was named to the user: a reveal style (the skill's four) OR a bundled look from
  # libi.list_caption_styles, by label or id — generate_captions takes either, and the 2026-09-27
  # re-run picked `news-serif` and told the user "Newsroom" (a pass the four-name list failed).
  - transcript_contains: ["cumulative", "Cumulative", "karaoke", "Karaoke", "word-by-word", "Word-by-word", "letter-by-letter", "Letter-by-letter",
      "Clean", "Boxed", "Outline", "Pop", "Beast", "Minimal", "Lower Third", "Hormozi", "Beasty", "TikTok", "Cyan Glow", "Pink Glow",
      "Newsroom", "news-serif", "Terminal", "Marker Gold", "Marker Green", "Bubble", "Shadow Pop", "Red Alert", "Cinematic", "Lux Gold",
      "Comic", "Retro", "Cyan Pop", "Magenta", "lower-third", "tiktok-classic", "mono-terminal", "cinematic-thin", "retro-cream", "karaoke-bar"]
    turn: 1
    scope: agent_text
    expect: present
  # AUD-2: the one-for-one edit went through update_overlay…
  - transcript_matches: '\[tool-call mcp__libi__libi_update_overlay\] \{[^\n]*"content":"[^"\n]*citizens'
    turn: 2
    expect: present
  # …and, the spoken-word count being unchanged, kept the timings: NO re-spread note.
  - transcript_matches: '\\"note\\":\\"The edited caption has different words'
    turn: 2
    expect: absent
  # The edit was kept: re-running generate_captions would replace the track and drop it.
  - { transcript_contains: "[tool-call mcp__libi__libi_generate_captions]", turn: 2, expect: absent }
```

## Behavioral expectations
- Loaded the `speech-captions` skill (not `animated-text-overlays`, not raw
  per-line text overlays).
- Transcribed the audio using **free local Whisper first** — did NOT call a paid
  STT provider (ElevenLabs or other) without explicit user approval.
- Read per-word timings from the RAW word array via
  `libi.analysis_get_audio_chunks` — did NOT reverse-engineer word boundaries
  from `libi.analysis_search_transcript` context windows.
- Built caption cues for **only the first phrase** ("And so, my fellow Americans", before
  the pause) — not the whole recording.
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
- Turn 2: edited the cue's text in place with `libi.update_overlay({ content })` and did
  not claim the word timings were re-spread or approximate (they were kept).
