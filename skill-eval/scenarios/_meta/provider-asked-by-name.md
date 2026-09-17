---
id: meta-provider-asked-by-name
title: Asked whether fal.ai is available when it isn't, the agent shows the provider card instead of answering in prose
skills: []
mcps: []
agent: claude-code
runs: 1
timeoutSec: 300
covers: [provider-gate, suggest-provider, chat-card, third-party, provider-question]
---

> **Why.** Found on Windows (2026-09-14): before fal.ai was connected, the user asked "does fal ai mcp is
> available on the session and if so which tools it has?". The agent searched its tools for "fal", found only libi
> tools that mention fal, and answered in prose ("connect the fal MCP in your agent config") — no
> `libi.suggest_provider` call, so the chat showed no card with the fal.ai / Higgsfield buttons. Two things made
> that likely: the instructions sent the agent to `suggest_provider` only before GENERATING, and neither provider
> tool's description named fal.ai, so Claude Code's tool search for "fal" could not surface them. Both are fixed
> (`mcp/instructions-core.md`, `mcp/server.ts` + `PROVIDER_NAMES_FOR_DESCRIPTIONS`); this pins the behaviour.
>
> **Why `mcps: []`.** libi's own tools and no provider, so fal is not connected and lands in `suggested`
> (`_meta/provider-card-third-party.md` has the precondition about the machine's real `~/.claude.json`).
>
> **Needles.** Same shapes as `_meta/provider-card-third-party.md`: the call renders under its ACP wire title, and
> the result is the escaped compact JSON of the tool's return value. fal offers `image` and `video`, so the kind the
> agent picks is either; fal leads `suggested` whichever it is. The needle anchors on `suggested` because a bare
> `"id":"fal"` also matches `covered` — a machine where fal IS registered would give a Higgsfield card and pass.
>
> **Why `skills: []`.** The question is not a generation, and what changed is the core instructions and the tool
> descriptions; a generation skill would load the provider gate's own wording on top.

## Prompt
Is fal.ai available in this session? If so, which of its tools can you use?

## Hard invariants
```yaml
assertions:
  # The question reached the provider tool instead of being answered in prose.
  - { transcript_contains: "[tool-call mcp__libi__libi_suggest_provider]", expect: present }
  # The in-app answer is the card payload, and fal is on it.
  - { transcript_contains: '\"status\":\"card\"', expect: present }
  - { transcript_contains: '\"suggested\":[{\"id\":\"fal\"', expect: present }
  # Nothing was generated.
  - { tool: "run_model", expect: absent }
  - { tool: "submit_job", expect: absent }
```

## Behavioral expectations
- Said plainly that fal.ai is not available in this session, and that the card in the chat has the buttons to
  connect it (or Higgsfield), then stopped.
- Did not ask for a key, did not print an `mcp add` command, and did not list claude.ai connectors or unrelated
  libi tools as if they answered the question.
