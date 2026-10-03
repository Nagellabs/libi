---
id: agent-speed-audio-level-measure
title: A level change under narration is set on the clip and measured with audio_analyze, never baked or decoded with ffmpeg
skills: ["*"]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1500
share: [bin]
hooks: skill-eval/scenarios/agent-speed/02-audio-level-measure.hooks.ts
fixtures:
  - skill-eval/fixtures/dreams-bench/tidewater-lights-30s.m4a
  - __tests__/fixtures/audio/jfk.wav
covers: [agent-speed, audio-levels, gainDb, volume-envelope, audio-duck, audio_analyze, never-bake, call-ceiling]
---

> **What this catches.** In the Dreams session the agent mixed a ducked bed in ffmpeg, re-uploaded
> it into six pieces and swapped every clip, then measured levels with numpy; two of its notes
> were workarounds for a fixed bug. The level is a property of the CLIP: `gainDb`, volume-envelope
> keys, the duck (all in the manual's audio-clips section, the Workflow's step 10 and
> `music-creation`), and `libi.audio_analyze` reads what the piece actually plays.
>
> The seed puts a 30 s song on the timeline at full level under an 11 s narration, with an end
> card at the tail. The `verify` hook checks the OUTCOME from the manifest: still one music clip on
> the ORIGINAL file and no new audio file in the piece (nothing baked), the song audible the whole
> way, 10 dB (±1.5) quieter under the narration than over the end card, and the end card at full
> level (−1 … +3 dB). A duck keyed on the narration and an envelope both satisfy it; the level
> model is volume × `gainDb` × envelope × the duck's reduction while its sidechain plays.
>
> **The measure call is the other half.** "Tell me what it measures" has to come from
> `libi.audio_analyze` `measure` (the real mix, through the export path), not from a calculation or
> from ffmpeg on the files. `share: [bin]` hands the hermetic home the real ffmpeg the measure job
> renders with.

## Prompt

The song in "{{seed:piece}}" is too loud under the narration. Keep it at full level over the end card, and make it 10 dB quieter than that while the narration plays. Then tell me what the mix actually measures under the narration and over the end card.

## Hard invariants

```yaml
assertions:
  # It measured the piece's real mix.
  - { transcript_matches: "\\[tool-call mcp__libi__libi_audio_analyze\\] \\{[^\\n]*\"action\":\"measure\"", expect: present }
  - { transcript_contains: "[tool-call mcp__libi__libi_audio_analyze]", count: "<=5" }
  # Never baked: no upload of a mixed file, no shell audio tooling.
  - { transcript_contains: "[tool-call mcp__libi__libi_upload_file]", expect: absent }
  - { transcript_matches: "\\[tool-call (?!mcp__)[^\\n]*\"command\":\"[^\\n]*\\b(?:ffmpeg|ffprobe|sox|volumedetect|loudnorm|ebur128|numpy)\\b", expect: absent }
  # A short path: manual, survey, the level edit, measure, a second measure, the answer.
  - { transcript_contains: "[tool-call mcp__libi__libi_", count: "<=14" }
```

## Behavioral expectations

- Sets the level on the clip (`gainDb`, volume-envelope keyframes or `libi.audio_duck` keyed on the narration) rather than producing a new audio file.
- Measures before and/or after the change, over ranges that sit under the narration and over the end card, and reports those numbers in its own words.
- Does not claim a figure it did not read from `audio_analyze`; says where a number is a rule of thumb, not a measurement.
