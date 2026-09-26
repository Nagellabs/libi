---
id: meta-elevenlabs-voiceover
title: Agent reaches ElevenLabs only on explicit opt-in voiceover request
skills: [voiceover-production, ai-asset-generation]
mcps: [elevenlabs]
agent: claude-code
runs: 1
timeoutSec: 540
covers: [elevenlabs, voiceover, opt-in-voiceover, text-to-speech, elevenlabs-hosted, one-generation, poll-then-download]
---

> **STATUS (2026-06-05): LENIENT — asserts the fake-ElevenLabs mirror is reached.**
> The user EXPLICITLY asks for a single ElevenLabs voiceover, so the opt-in path
> in `voiceover-production` should run the speech tool against the test-mode fake and
> import the resulting audio. This proves the ElevenLabs tool path end-to-end at zero cost.
>
> **2026-09-25: ElevenLabs is its hosted server.** Speech is `creative_generate_speech`, a
> flow run: it returns session ids, a status poll returns a short-lived audio URL
> (`media[].url`), and `generations_count` defaults to **4** takes, each charged. The fake keeps that default, so
> the needles below catch an agent that forgets `generations_count: 1`
> (`ai-asset-generation`'s `references/providers/elevenlabs.md`). Its first status poll
> always answers "still running", so a finished result needs at least two polls. A voice
> must come from `creative_list_voices`: the fake refuses any other `voice_id`.

> **2026-09-25: the prompt no longer claims a video.** The harness starts every scenario
> from an EMPTY piece, and the old prompt said "a finished 12-second product video already
> in this piece". The first run on the hosted server listed voices, then found no video and
> stopped honestly (`skill-eval/runs/2026-09-25T08-03-23-998Z` in the eval worktree). What
> this scenario tests is the ElevenLabs speech path, so the prompt now asks for the
> voiceover on its own, as an audio clip in the piece.

## Prompt
I'm adding my 12-second product video to this piece later. For now, make its voiceover:
ONE consistent, human-sounding **ElevenLabs** voiceover of this line — "Meet AquaFlow,
hydration that keeps up with you." Use ElevenLabs specifically, not the on-device voice.
Generate it and add it to the piece as an audio clip.

## Hard invariants
```yaml
assertions:
  # The agent reached the ElevenLabs speech path and actually ran it (the headline assertion).
  - { provider: "elevenlabs", tool: "creative_generate_speech", where: "input.estimate_only != true", expect: present }
  # ONE take: the hosted default is four, each charged. An omitted count is not 1 either.
  - { provider: "elevenlabs", tool: "creative_generate_speech", where: "input.generations_count != 1", expect: absent }
  # The voice came from the list, not from memory.
  - { provider: "elevenlabs", tool: "creative_list_voices", expect: present }
  # It polled the run to completion (the fake's first poll is always still running).
  - { provider: "elevenlabs", tool: "creative_get_flow_run_status", count: ">=2" }
  # …and imported what the poll's `media[].url` served.
  - { transcript_contains: "[tool-call mcp__libi__libi_upload_file]", expect: present }
  # It did NOT silently fall through to a fal endpoint for the voice.
  - { provider: "fal", expect: absent }
```

## Behavioral expectations
- Honored the explicit "ElevenLabs specifically" instruction — used
  `creative_generate_speech` with a voice from `creative_list_voices`, not Kokoro.
- Passed `generations_count: 1` and a short `context`; priced the run (`estimate_only`) and
  stated the cost before running it.
- Waited `poll_after_seconds` between polls, then downloaded the poll's `media[].url` at
  once and imported it into the piece via `libi.upload_file` with `aiGeneration` provider `elevenlabs`.
- Never called an `agents_*` tool.
