---
id: agent-speed-insert-time-folder
title: Making the intro 3 seconds longer in every piece of a folder is one insert_time batch, not manual retime math
skills: ["*"]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
hooks: skill-eval/scenarios/agent-speed/03-insert-time-folder.hooks.ts
fixtures:
  - skill-eval/fixtures/dreams-bench/intro-clip-12s.mp4
  - skill-eval/fixtures/dreams-bench/tidewater-lights-30s.m4a
  - __tests__/fixtures/audio/jfk.wav
covers: [agent-speed, ripple-retime, insert_time, apply_ops, multi-piece-edit, call-ceiling]
---

> **What this catches.** In the Dreams session about a hundred calls went into moving every later
> layer by hand when an intro grew by 3 s. `libi.clip` action `insert_time` is the ripple insert:
> it shifts everything at or after `at`, stretches the full-length layers (a backdrop, a music
> bed) and extends the intro with its trim and its own sound. The rule is the manual's Workflow
> step 12 and the audio-clips section; `stitching-multi-clip` has the same text for the skill
> path. This scenario is the regression test for finding it unprompted.
>
> The seed builds three 9:16 copies of one piece (shared ids): an intro video with its own sound,
> a full-length backdrop and music bed, a narration with a caption, and an end card. The `verify`
> hook checks the OUTCOME in all three: intro 5 to 8 s, narration, caption and end card +3 s, the
> backdrop and the bed grown to cover the 23.5 s piece. Per-layer `update_overlay` edits satisfy the
> outcome only if the agent also grows the two full-length layers and the intro's sound correctly,
> and the ceiling below makes that route expensive: it fails.
>
> Fixtures are the benchmark's: `jfk.wav`, `intro-clip-12s.mp4` (12 s, so the intro has footage
> for 8 s) and `tidewater-lights-30s.m4a`.

## Prompt

Make the intro 3 seconds longer in every piece of the "{{seed:folder}}" folder. Everything after it moves with it, and the music and the background still have to cover the whole video.

## Hard invariants

```yaml
assertions:
  # It used the ripple insert (in a batch op or a direct call).
  - { transcript_contains: "\"action\":\"insert_time\"", count: ">=1" }
  - { transcript_contains: "[tool-call mcp__libi__libi_apply_ops]", count: ">=1" }
  # No hand retime and no per-piece loop.
  - { transcript_contains: "[tool-call mcp__libi__libi_update_overlay]", count: "<=1" }
  - { transcript_contains: "[tool-call mcp__libi__libi_audio_clip]", count: "<=1" }
  - { transcript_contains: "[tool-call mcp__libi__libi_clip]", count: "<=1" }
  - { transcript_contains: "[tool-call mcp__libi__libi_get_composition]", count: "<=3" }
  - { transcript_contains: "[tool-call mcp__libi__libi_", count: "<=14" }
```

## Behavioral expectations

- Uses `extendTarget` (the intro overlay) so the intro's trim and its own sound grow with it, and tells the user if the source clip had no footage left.
- Does not move layers one by one, and does not do the arithmetic itself.
- Reads the result of `insert_time` (`shifted`, `stretched`, `leftSpanning`) instead of re-reading every piece.
