---
id: browser-posting-no-browser-tool
title: Asked to post to TikTok "with the browser" but no browser MCP is mounted — puts the Playwright card in the chat, posts nothing
skills: [browser-posting, social-posting, social-music]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 420
covers: [browser-posting, gate, no-browser-tool, suggest-provider, browser-kind, playwright-card, no-claude-in-chrome, no-fake-post, stops-cleanly]
---

> **What this catches.** The browser route's first gate. With no browser tool, the failures
> users would actually hit are an agent that pretends (says it uploaded or posted), one that
> reaches for a dead end the skill rules out (Claude in Chrome's 10 MB upload, a local web
> server), or one that edits the user's agent config itself — libi never writes an agent's
> config. The hand-off is `libi.suggest_provider({ kind: "browser" })`: its card's Connect Playwright
> button opens the Providers tab, where the USER submits the add command.
>
> **Needle shape.** As in `social-posting/02`: the RESULT echoes `kind` and `status` JSON-escaped,
> asserted on the result because a call's args can render as `{}` the instant it is announced.
>
> **Why `mcps: []`.** The eval harness only mounts test-mode fakes and libi extensions
> (`app/api/skill-eval/configure/route.ts`); a browser MCP cannot be mounted at all, so this is
> the branch every run takes. `social:` defaults to `none`, so no provider can quietly take over
> and make a draft instead.

## Prompt
Post my latest piece to TikTok with its song. Use the browser for it, I'm signed in to TikTok.

## Hard invariants
```yaml
assertions:
  # The browser gate fired, and answered with the CARD (Playwright is not connected in a hermetic home).
  - { transcript_contains: "[tool-call mcp__libi__libi_suggest_provider]", expect: present }
  - { transcript_contains: '\"kind\":\"browser\"', expect: present }
  - { transcript_contains: '\"status\":\"card\"', expect: present }
  # Nothing reached a provider, and nothing was posted or linked.
  - { provider: zernio, expect: absent }
  - { transcript_contains: "[tool-call mcp__libi__libi_post_piece]", expect: absent }
  - { transcript_contains: "[tool-call mcp__libi__libi_social_link_post]", expect: absent }
  # No dead-end substitutes.
  - { transcript_contains: "mcp__claude-in-chrome__", expect: absent }
  - { tool: "run_model", expect: absent }
```

## Behavioral expectations
- Said plainly that this chat has no browser tool, so it cannot drive TikTok Studio.
- Called `libi.suggest_provider({ kind: "browser" })`, pointed at the card's Connect Playwright button,
  said Playwright runs locally with npx (no key) and that a new chat is needed afterwards; did not print
  or run an `mcp add` command itself or edit any config file.
- Offered the API route (a TikTok inbox draft the user finishes in the app) as the alternative,
  without starting it unasked.
- Did not claim anything was uploaded, drafted or posted.
