---
id: meta-provider-card-third-party
title: In the app, suggest_provider answers a video request with a card payload
skills: [generic-video, ai-asset-generation, ai-video-models, using-storyboard, realistic-image-generation]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 420
covers: [provider-gate, suggest-provider, chat-card, third-party]
---

> **Why.** In the app, `libi.suggest_provider` no longer opens a panel beside the chat: it
> returns `status: "card"` and the chat renders that payload as a card
> (`mcp/tools/provider-tools.ts#suggestProvider`). This pins the wire payload for a kind
> libi can only get from a third party — video, which the catalog
> (`lib/providers/catalog.ts`) offers through fal and Higgsfield and no on-device
> extension. `_meta/provider-card-on-device.md` is the other kind class.
>
> **Why `mcps: []`.** An empty list is a session with libi's own tools and no provider
> (`/api/skill-eval/configure` → `setTestModeFakesEnabled(false)`), so nothing is
> connected and both video providers land in `suggested`. Confirm `acp_cache_built` logs
> `["libi"]` — ONE name — before trusting a pass.
>
> **Precondition.** `scripts/skill-eval/harness.ts` isolates only `LIBI_HOME` for the run —
> it reads the machine's real `~/.claude.json` and shells out to `codex mcp list`, so
> "nothing is connected" above depends on the machine, not just `mcps: []`. If fal or
> Higgsfield is genuinely registered there, the order needle fails loudly rather than
> passing falsely.
>
> **How the needles are shaped.** The tool call renders under its ACP wire title. Its args
> can render as `{}` in the instant the call is first announced — claude-agent-acp reports
> it before the input is known — but `SessionEventHandler#adoptToolCallArgs`
> (`lib/agents/session-event-handler.ts:1280`) DOES adopt the later `rawInput` into the
> cached part once it arrives (`_meta/no-provider.md` has the detail). The result is the
> compact `JSON.stringify` of the tool's return value inside the MCP text content
> (`mcp/server.ts#makeContent`), stringified again by the transcript renderer
> (`scripts/skill-eval/harness.ts#renderPart`), so every quote in it is escaped:
> `\"status\":\"card\"`. The `suggested` needle is ORDER-sensitive on purpose — on-device
> extensions lead the card, then remote providers in catalog order, so for video the first
> entry is fal. A plain `\"id\":\"fal\"` would still pass if the order broke.

## Prompt
Generate a 5-second video clip of a fox running through snow and put it on the piece.

## Hard invariants
```yaml
assertions:
  # The gate fired.
  - { transcript_contains: "[tool-call mcp__libi__libi_suggest_provider]", expect: present }
  # The in-app answer is the card payload, for the kind that was asked for.
  - { transcript_contains: '\"status\":\"card\"', expect: present }
  - { transcript_contains: '\"kind\":\"video\"', expect: present }
  # fal leads the suggestions (no on-device extension makes video; catalog order is fal, Higgsfield).
  - { transcript_contains: '\"suggested\":[{\"id\":\"fal\"', expect: present }
  # The panel-era status is gone.
  - { transcript_contains: '\"status\":\"shown\"', expect: absent }
  # It stopped: nothing was generated.
  - { tool: "run_model", expect: absent }
  - { tool: "submit_job", expect: absent }
```

## Behavioral expectations
- Called `libi.suggest_provider({ kind: "video" })`, told the user in one line that a card
  with the choices is in the chat, and stopped. Did not ask for a key.
- Did not describe a panel, a settings page, or a command to run — the card is the whole
  hand-off.
