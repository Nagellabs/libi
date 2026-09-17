---
id: music-video-local-extension-is-the-provider
title: Music-video with visuals deferred routes the track to libi's own extension, not to a paid provider
skills: [music-video-creation, music-creation, ai-asset-generation]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 480
covers: [provider-gate, music-video, local-first, ace-step, extension-is-a-provider, no-suggest-provider, needs-install]
---

> **Why this scenario exists.** A later split removed the last paid vendor name from
> `music-video-creation/SKILL.md`: the campaign-transparency bullet used to escalate to
> "elevenlabs for English vocals, fal-ai for specific style models", and now escalates to
> "a paid `music` provider (see `references/providers/<id>.md`)". That is the same kind of
> weakening flagged one level down elsewhere — a body with no paid provider in view makes the
> gate's *"libi's own extension tools count as a provider"* clause the ONLY thing standing
> between the user and being sent shopping for a music provider the free on-device model
> already covers. `music-creation/01-local-extension-is-the-provider.md` pins that for the
> skill the user reaches directly; this pins it for the **wrapper**, which is a different
> entry point with its own inlined copy of the gate and its own campaign-cost section.
>
> **Why `mcps: []`.** `/api/skill-eval/configure` calls
> `setTestModeFakesEnabled(mcps.length > 0)`, so an empty list is a session with libi's own
> tools and no remote provider at all. Confirm `acp_cache_built` logs `["libi"]` — ONE
> name — before trusting a result.
>
> **Why the prompt defers the visuals.** With no remote provider there is no video provider
> either, so a prompt that also asked for AI clips would legitimately reach
> `libi.suggest_provider({ kind: "video" })` and make the headline assertion below
> unwinnable. Deferring the visuals keeps the run on the music half — which is the half
> the split above touched — and keeps it cheap (no storyboard, no generation).
>
> **Why `needs_install` is the expected outcome, not a failure.** The harness boots libi
> under a fresh temp `LIBI_HOME` with no ACE-Step weights and no `uv`, so
> `libi.generate_music` answers `status:"needs_install"` with the ~8.3 GB size
> (`mcp/tools/music-tools.ts#generateMusic`). The pass is the agent surfacing that and the
> install plan rather than switching provider. `local-music`'s plan forbids the agent from
> installing `uv` itself, so the path terminates safely on its own.
>
> **Needle shapes.** A skill load renders as `[tool-result ok] "Launching skill: <name>"`;
> the bare name is not enough, because the agent's own reasoning names skills it did not
> load. libi tool calls render under their ACP wire title —
> `[tool-call mcp__libi__libi_generate_music]` — not the dotted `libi.` form. The
> paid-path assertions are keyed on `endpoint_id` / `unknown_endpoint`, never on `tool`.

## Prompt
I want to make a music video out of this piece — generate the track first, put it under the
visuals, and then we'll get the lyrics up on screen as synced captions. I'm supplying the
visuals myself later, so do NOT generate any video clips or images; just the music and the
caption plan.

## Hard invariants
```yaml
assertions:
  # It loaded the wrapper, not just the interview skill underneath it.
  - { transcript_contains: 'Launching skill: music-video-creation', expect: present }
  # THE HEADLINE: the wrapper treated libi's own extension as the music provider.
  - { transcript_contains: "[tool-call mcp__libi__libi_generate_music]", expect: present }
  # …and got the harness's expected answer, which it must surface rather than route around.
  - { transcript_contains: "needs_install", expect: present }
  # libi HAS a provider for this kind, so the gate's shopping path must NOT fire. This is
  # the assertion that fails if the split's provider-agnostic bullet is misread as
  # "no vendor named here, so go find one".
  - { transcript_contains: "[tool-call mcp__libi__libi_suggest_provider]", expect: absent }
  # It did not improvise a provider or invent an endpoint when the local one needed setup.
  - { endpoint_id: "*", expect: absent }
  - { unknown_endpoint: true, expect: absent }
  # Cheapness is an invariant, not a hope: the 8.3 GB weights pull is never started.
  - { transcript_contains: "[tool-call mcp__libi__libi_music_download_model]", expect: absent }
```

## Behavioral expectations
- Treated `libi.generate_music` as the music provider — free, on-device, no key — rather
  than reporting "no music provider is connected" or reaching for the paid escalation the
  campaign-cost section now describes without naming.
- Delegated the interview to `music-creation` (Step 1 of the flow) and ran enough of it to
  have something to generate, instead of demanding a full spec or inventing one silently.
- On `needs_install`, told the user the **~8.3 GB** size and followed the install flow
  (`libi.get_install_plan({ mcpId: "local-music" })`) rather than switching provider. Did
  not try to install `uv` itself — the plan reserves that for the user.
- Did **not** ask for an API key and did not suggest the user go buy a music provider. The
  4+-unsatisfying-generations escalation had not been reached; on the FIRST attempt a paid
  suggestion is exactly what the split's bullet forbids.
- Respected the deferral: no AI clip or image generation, and no storyboard spin-up for
  visuals the user said they would supply.
- Did not claim music was added to the piece, and did not build captions against a track
  that does not exist. An honest "here's what it needs" is the pass.
