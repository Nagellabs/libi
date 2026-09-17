---
id: meta-provider-card-on-device
title: In the app, suggest_provider puts the on-device music extension first on its card
skills: [generic-video, ai-asset-generation]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 300
covers: [suggest-provider, chat-card, on-device]
---

> **Why.** The in-app `libi.suggest_provider` answer is a card payload
> (`status: "card"`), and the card puts on-device extensions first: an extension is free
> after one download and needs no account (`mcp/tools/provider-tools.ts#suggestProvider`).
> Music is the kind where that ordering is visible — the catalog (`lib/providers/catalog.ts`)
> lists ElevenLabs BEFORE ACE-Step, so the card only leads with ACE-Step if the reordering
> works. `_meta/provider-card-third-party.md` is the other kind class.
>
> **Why the prompt names the tool.** This scenario pins the payload, not the gate. Left to
> a free-form music request, the agent correctly routes to `libi.generate_music` (see
> `music-creation/01-local-extension-is-the-provider.md`) and never calls
> `suggest_provider` at all. Asking for the call directly gets the payload into the
> transcript cheaply, and the absence assertions keep the run from sliding into a
> generation or an 8.3 GB model download.
>
> **Why `mcps: []`.** No remote provider is connected and the hermetic `LIBI_HOME` has no
> ACE-Step weights, so both ACE-Step and ElevenLabs land in `suggested` rather than
> `covered`.
>
> **Precondition.** `scripts/skill-eval/harness.ts` isolates only `LIBI_HOME` for the run —
> it reads the machine's real `~/.claude.json` and shells out to `codex mcp list`, so "no
> remote provider is connected" above depends on the machine, not just `mcps: []`. If
> ElevenLabs is genuinely registered there, the order needle fails loudly rather than
> passing falsely.
>
> **How the needles are shaped.** As in `_meta/provider-card-third-party.md`: the result is
> a string of JSON stringified again by the transcript renderer, so its quotes are escaped.
> The `suggested` needle is ORDER-sensitive — a plain `\"id\":\"ace-step\"` would pass with
> ElevenLabs first, which is exactly the regression it exists to catch.

## Prompt
Call libi.suggest_provider with kind "music" and tell me, in one line, what it returned. Do not generate anything.

## Hard invariants
```yaml
assertions:
  - { transcript_contains: "[tool-call mcp__libi__libi_suggest_provider]", expect: present }
  - { transcript_contains: '\"status\":\"card\"', expect: present }
  # The on-device suggestion carries the extension id the card's install button targets.
  - { transcript_contains: '\"extensionId\":\"local-music\"', expect: present }
  # …and it leads the card, ahead of ElevenLabs.
  - { transcript_contains: '\"suggested\":[{\"id\":\"ace-step\"', expect: present }
  # Nothing was generated or downloaded.
  - { transcript_contains: "[tool-call mcp__libi__libi_generate_music]", expect: absent }
  - { transcript_contains: "[tool-call mcp__libi__libi_music_download_model]", expect: absent }
```

## Behavioral expectations
- Named ACE-Step as the on-device option (free, a one-time download) and ElevenLabs as the
  paid one.
- Did not install, download, or generate anything, and did not ask for a key.
