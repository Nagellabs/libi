---
id: music-creation-elevenlabs-hosted-one-take
title: Asked for ElevenLabs music, the agent runs ONE hosted music generation, polls it, and imports the audio from the poll's media[].url
skills: [music-creation, ai-asset-generation]
mcps: [elevenlabs]
agent: claude-code
runs: 1
timeoutSec: 480
covers: [music-creation, elevenlabs, elevenlabs-hosted, one-generation, estimate-first, poll-then-download, generate-in-flow]
---

> **Why this scenario exists (2026-09-25).** ElevenLabs moved to its hosted MCP server
> (`lib/providers/catalog.ts`). Its music is not a `compose_music` call any more but a flow
> run: `creative_generate_in_flow` with `node_type: "music"` returns session ids, a status
> poll returns a short-lived audio URL (`media[].url`), and `generations_count` defaults
> to **4** tracks, each charged. `music-creation`'s `references/providers/elevenlabs.md` and the call mechanics in
> `ai-asset-generation`'s `references/providers/elevenlabs.md` say: one generation, priced
> with `estimate_only` first, polled until done, downloaded at once. The fake keeps the
> hosted default of 4 and answers its first poll with "still running", so each rule is a
> needle below.
>
> **Why the user names ElevenLabs.** Local ACE-Step is the default and `music-creation/02`
> holds that line. Here the user explicitly asks for ElevenLabs (English vocals), which is
> the reference's own "reach for it" case, so the paid path is the pass.

## Prompt
Make me a 30-second upbeat pop jingle with English vocals singing "AquaFlow keeps up with
you" for this piece. Use ElevenLabs for it, not the on-device music model: I want its vocals.
Add the finished track to the piece.

## Hard invariants
```yaml
assertions:
  # Either skill: music-creation's own description sends a request that already names the
  # style, length and lyrics straight to ai-asset-generation, which owns the ElevenLabs call
  # mechanics (its first run did exactly that and passed every other needle).
  - { transcript_contains: ['Launching skill: music-creation', 'Launching skill: ai-asset-generation'], expect: present }
  # It ran ElevenLabs' music node for real (not just a price).
  - { provider: "elevenlabs", tool: "creative_generate_in_flow", where: "input.estimate_only != true", expect: present }
  - { provider: "elevenlabs", tool: "creative_generate_in_flow", where: "input.node_type == music", expect: present }
  # ONE track per call: the hosted default is four, each charged; an omitted count is not 1.
  - { provider: "elevenlabs", tool: "creative_generate_in_flow", where: "input.generations_count != 1", expect: absent }
  # It priced the run before running it.
  - { provider: "elevenlabs", tool: "creative_generate_in_flow", where: "input.estimate_only == true", expect: present }
  # It polled the run to completion (the first poll is always still running).
  - { provider: "elevenlabs", tool: "creative_get_flow_run_status", count: ">=2" }
  # …and imported what the poll's `media[].url` served.
  - { transcript_contains: "[tool-call mcp__libi__libi_upload_file]", expect: present }
  # No other provider for the music.
  - { provider: "fal", tool: "run_model", expect: absent }
  - { provider: "fal", tool: "submit_job", expect: absent }
```

## Behavioral expectations
- Stated the price the `estimate_only` call returned (in ElevenLabs credits) before running.
  Under the harness's pre-authorization it may then proceed without waiting.
- Passed a short `context` on every call and never called an `agents_*` tool.
- Waited `poll_after_seconds` (with `libi.sleep`) between polls, rather than hammering the
  status tool.
- Downloaded the poll's `media[].url` right away to a temp path, then `libi.upload_file` with
  `aiGeneration` provider `elevenlabs`, `model` `eleven_music_v2` (or the model it used), and
  added the track as a standalone audio clip.
