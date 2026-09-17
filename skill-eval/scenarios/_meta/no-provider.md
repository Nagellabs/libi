---
id: meta-no-provider
title: With no video provider connected, the agent suggests one and stops
skills: [generic-video, ai-asset-generation, ai-video-models, using-storyboard, realistic-image-generation]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 420
covers: [provider-gate, suggest-provider, no-provider, no-generation, stops-cleanly]
---

> **Why `mcps: []`.** `app/api/skill-eval/configure/route.ts` calls
> `setTestModeFakesEnabled(mcps.length > 0)` (`lib/mcp-config.ts`), so an empty list is a
> session with libi's own tools and nothing else — one ACP entry, `libi`, and no
> provider. That is the condition the provider gate exists for. There are no
> `mcp_servers` rows to disable any more; the flag is the whole mechanism. If a future
> change makes the test-mode fakes bypass it, this scenario silently stops testing
> anything: confirm `acp_cache_built` logs `["libi"]` — ONE name — before trusting a
> pass.
>
> **How the needles are shaped.** The transcript renders a tool call under its ACP wire
> title — `[tool-call mcp__libi__libi_suggest_provider]` — not the dotted
> `libi.suggest_provider`. The call's args can render as `{}` in the instant the tool call
> is first announced — claude-agent-acp reports it before the input is known — but that is
> not permanent: `SessionEventHandler#adoptToolCallArgs`
> (`lib/agents/session-event-handler.ts:1280`) DOES adopt the later `rawInput` into the
> cached tool-call part once it arrives. This scenario still asserts `kind` on the tool's
> RESULT rather than the call's args, which echoes `params.kind` back
> (`mcp/tools/provider-tools.ts#suggestProvider`) and renders JSON-escaped — that keeps the
> assertion independent of exactly when the args update lands. In the app that
> result is a card payload the chat renders in place — nothing opens beside the chat — so it
> reads `{\"status\":\"card\",\"kind\":\"video\",...}`. No other libi tool emits
> `"kind":"video"` — `list_providers` only reports `kind: "remote-mcp" | "extension"`. The
> card payload itself (status and suggestion order) is pinned by
> `_meta/provider-card-third-party.md`; this scenario is about the agent stopping.

## Prompt
Generate a 5-second video clip of a fox running through snow and put it on the piece.

## Hard invariants
```yaml
assertions:
  # The gate fired: the agent asked libi to surface a video provider.
  - { transcript_contains: "[tool-call mcp__libi__libi_suggest_provider]", expect: present }
  # …and asked for the right kind (echoed back in the tool result; see the note above).
  - { transcript_contains: '\"kind\":\"video\"', expect: present }
  # It stopped instead of improvising: nothing was generated, on any provider.
  - { tool: "run_model", expect: absent }
  - { tool: "submit_job", expect: absent }
  - { unknown_endpoint: true, expect: absent }
  # It did not substitute a libi on-device tool that cannot make video.
  - { transcript_contains: "[tool-call mcp__libi__libi_generate_music]", expect: absent }
  - { transcript_contains: "[tool-call mcp__libi__libi_generate_speech]", expect: absent }
```

## Behavioral expectations
- Called `libi.suggest_provider({ kind: "video" })` and told the user, in plain words and
  briefly, that a card with the choices is now in the chat — nothing is connected, and
  fal and Higgsfield are the suggestions.
- **Stopped.** Did not ask the user to paste an API key, did not offer to "try anyway",
  did not loop re-checking its tool list, and did not silently produce a still image or a
  code overlay as a stand-in for the video that was asked for.
- Did not claim a clip was created. A piece with no clip and an honest explanation is the
  pass; a piece with a substituted asset is the failure this scenario exists to catch.
