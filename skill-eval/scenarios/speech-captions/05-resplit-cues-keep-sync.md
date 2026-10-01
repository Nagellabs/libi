---
id: speech-captions-resplit-keep-sync
title: Re-splitting generated caption cues keeps word sync and the track style
skills: [speech-captions, audio-analysis]
mcps: []
agent: claude-code
runs: 1
# Same caption-family tier as 01 / 02: transcription can include a model install.
timeoutSec: 1200
# Local Whisper needs `uv` and the weights (see speech-captions/01). A COPY, never a link.
share: [bin, models]
# The shared transcription fixture (whisper.cpp's samples/jfk.wav, 11 s, one speaker —
# __tests__/fixtures/audio/jfk.SOURCE.md).
fixtures: [__tests__/fixtures/audio/jfk.wav]
covers: [captions, transcript, caption-windows, caption-resplit, captionFromFileId, track-style, NQ-1]
---

> **Why it exists (week 2026-10-02, NQ-1).** The 2026-09-27 evals of `01` and `02` caught the
> agent re-splitting generated cues with `update_overlay {content, startTime, duration,
> captionFromFileId}`. Two things broke: the words came back 2 s early (the recording sat at
> 2 s; `captionFromFileId` windowed Whisper's SOURCE-time words against the cue's TIMELINE
> window), and every re-split cue left its track and fell back to plain Inter (the directive
> always wrote `cap-<fileId>-custom` with `useTrackStyle: false`). Both are fixed in the tool:
> the words map through where the file plays on the timeline; a cue of a `generate_captions`
> track keeps its group and style, and a text overlay ADDED to split a line further joins the
> track with its nearest cue's look. A text cue takes a word by where it starts (half-open), so
> contiguous Whisper words never bleed across a shared boundary.
>
> **What the needles hold.**
> - The re-split goes through `update_overlay` with `captionFromFileId` (the skill's
>   "Re-splitting generated cues" route), never a re-run of `generate_captions`, which would
>   rebuild the track and throw the re-split away.
> - No cue left its track: `cap-<fileId>-custom` never appears in turn 2 — it is the group only
>   a code/three overlay (or a cue of another file's track) gets. This needle is conditional:
>   `update_overlay` returns only `{overlayId}`, so it can fire only when the agent reads the
>   overlays back (`get_overlays` / `get_piece_state`), as the 2026-09-27 run did.
> - The agent has no sync loss to explain: none of the phrasings the 2026-09-27 run used ("2s
>   early") or their variants. "offset" is deliberately NOT a needle — a correct run can say
>   "accounting for the recording's 2 s offset".
> - Tolerant of the route: the transcript may come from `analysis_transcribe_audio` or an
>   existing analysis; `audio_add_clip` or any other way of putting the file at 2 s is fine.

## Prompt
Upload the voice recording {{fixture:jfk.wav}} to this piece and put it on the timeline
starting 2 seconds in (I want a beat of silence first). Then add captions synced to what he's
saying.

## Replies
1. Re-split the captions at the commas / sentence ends.

## Hard invariants
```yaml
assertions:
  # Turn 1 built a real track, so turn 2 has cues to re-split.
  - { transcript_contains: "[tool-call mcp__libi__libi_generate_captions]", turn: 1, expect: present }
  # The re-split re-synced each cue from the transcript via captionFromFileId…
  - transcript_matches: '\[tool-call mcp__libi__libi_update_overlay\] \{[^\n]*"captionFromFileId"'
    turn: 2
    expect: present
  # …without re-running generate_captions (which would replace the re-split track)…
  - { transcript_contains: "mcp__libi__libi_generate_captions", turn: 2, expect: absent }
  # …and no cue left its track (the custom group is for overlays outside any track).
  - transcript_matches: 'cap-[0-9a-f-]+-custom'
    turn: 2
    expect: absent
  # The words follow the clip's timeline position, so there is no sync loss to explain.
  - { transcript_contains: ["2s early", "2 s early", "2 seconds early", "out of sync", "broke sync"], turn: 2, scope: agent_text, expect: absent }
```

## Behavioral expectations
- Loaded the `speech-captions` skill and followed its "Re-splitting generated cues" section:
  one `update_overlay({ overlayId, content, startTime, duration, captionFromFileId })` per cue,
  `add_overlay` (kind text) first for any extra cue, `remove_overlay` for any cue no longer needed.
- Split at the recording's natural breaks ("And so, my fellow Americans," / "ask not what your
  country can do for you," / "ask what you can do for your country"), each cue's start/end taken
  from the transcript's word timings on the TIMELINE (the recording starts at 2 s).
- The re-split cues keep the track's style — no cue reverts to a plain default font.
- Did not re-run `generate_captions` to "restore sync", and did not tell the user the
  captions are early or offset.
