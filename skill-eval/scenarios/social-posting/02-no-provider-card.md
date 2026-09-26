---
id: social-posting-no-provider-card
title: With no social provider chosen, a "post this" request gets the provider card and stops
skills: [social-posting]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 420
covers: [social-posting, provider-gate, suggest-provider, no-provider, stops-cleanly, no-key]
---

> **What this catches.** The gate's first branch. With nothing connected, the failure
> users actually hit is an agent that improvises — asks for an API key, prints an
> `mcp add` command, describes a settings page, or claims it posted something. The card
> is the whole hand-off, and stopping is the pass.
>
> **Why `mcps: []` and no `social:`.** An empty MCP list detaches the test-mode fakes
> (`/api/skill-eval/configure` → `setTestModeFakesEnabled(false)`), so the agent has
> libi's tools and no zernio. `social:` defaults to `none`, which leaves libi with no
> provider selected — so `/api/social/status` answers `providerId: null` and the skill's
> step 2 applies. Both halves matter: with either one wrong the agent would have a real
> path to a draft and this scenario would test nothing while still reporting a result.
>
> **Needle shape.** The call renders under its ACP wire title, and the tool's RESULT
> echoes `kind` back JSON-escaped — asserted on the result rather than the args because
> a tool call's args can render as `{}` in the instant it is announced
> (`_meta/no-provider.md` has the detail).

## Prompt
Can you post this to TikTok?

## Hard invariants
```yaml
assertions:
  # The gate fired, for the right kind.
  - { transcript_contains: "[tool-call mcp__libi__libi_suggest_provider]", expect: present }
  - { transcript_contains: '\"kind\":\"social\"', expect: present }
  # It stopped: no provider was reached, and nothing was posted or linked.
  - { provider: zernio, expect: absent }
  - { transcript_contains: "[tool-call mcp__libi__libi_post_piece]", expect: absent }
  - { transcript_contains: "[tool-call mcp__libi__libi_social_link_post]", expect: absent }
  # It did not substitute an unrelated libi tool for the thing it cannot do.
  - { tool: "run_model", expect: absent }
  - { tool: "submit_job", expect: absent }
```

## Behavioral expectations
- Called `libi.social_status` (or went straight to the card) and then
  `libi.suggest_provider({ kind: "social" })`, said in one line that the chat now has the
  card with the connect button, and STOPPED.
- Did not ask the user for an API key, did not print a CLI command, and did not send them
  to a settings page instead of the card.
- Did not say or imply that anything was posted, drafted or scheduled.
