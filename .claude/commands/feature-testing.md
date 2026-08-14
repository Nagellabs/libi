---
description: Run the libi feature-testing dogfood workflow — verify recent agent-facing changes end-to-end through the actual libi agent in test mode.
allowed-tools: Bash, Read, Grep, mcp__Claude_in_Chrome__*
---

You are about to verify the user's recent libi changes end-to-end through the
actual libi agent. Follow these steps in order. The full background and
gap-detection guide lives at `.claude/skills/feature-testing/SKILL.md` —
read it first if you haven't already in this session.

## Step 1 — Detect dev-server state

Check whether the dev server is running and whether it's in test mode:

```bash
# Is :3456 listening?
lsof -i :3456 -P 2>/dev/null | head -3

# Is the server in test mode? Look for fake-ai-assets registration in recent log lines.
tail -50 ~/.libi/logs/server.log | grep -E "fake-ai-assets|TEST MODE|Loaded .* sessions"
```

Three states:

- **Server not running** → ask the user to run `LIBI_TEST_MODE=1 npx libi` and confirm
- **Server running, NOT in test mode** → ask the user to stop and restart with `LIBI_TEST_MODE=1 npx libi`
- **Server running in test mode** → proceed to Step 2

Do NOT spawn `LIBI_TEST_MODE=1 npx libi` yourself — it blocks the foreground.

## Step 2 — Establish a test scope

If the user invoked `/feature-testing` with arguments (e.g.
`/feature-testing catalog`), use that as the focus. Otherwise infer from
recent git activity:

```bash
git log --oneline -10
git diff --stat HEAD~3..HEAD
```

Pick a test prompt that exercises the changed area. Examples:

- Touched `mcp/tools/character-tools.ts` or related → catalog flow prompt
- Touched `ai-asset-generation` or `ugc-product-video` skills → UGC creation prompt
- Touched analysis pipeline → upload + analyze prompt
- Generic / can't tell → "List my pieces. Pick one with assets, summarize what's in it."

State the chosen prompt to the user before sending it: "I'll send the agent: '...' Sound good?"

## Step 3 — Drive the UI via Claude in Chrome MCP

Once the prompt is approved:

1. `mcp__Claude_in_Chrome__tabs_context_mcp` with `createIfEmpty: true` to get a tab
2. Navigate to `http://localhost:3456/editor`
3. Use `mcp__Claude_in_Chrome__find` for "New chat" button → click
4. Use `mcp__Claude_in_Chrome__find` for the "Describe a scene..." textarea
5. Click it, type the prompt, press Return
6. Wait in a polling loop for the response (the agent can take 30-90s for complex prompts)

While waiting, take screenshots periodically so you (and the user) can see
progress.

## Step 4 — Tail logs + browser console in parallel

**Server-side logs** — run two background Bash processes (`run_in_background: true`):

```bash
tail -f ~/.libi/logs/server.log
```
```bash
tail -f ~/.libi/logs/libi.log | jq 'select(.tag != "ffmpeg")'
```

**Browser-side console** — periodically (every ~10s while the agent runs, and once after it finishes):

```ts
// Grab UI/JS errors from the running editor tab
mcp__Claude_in_Chrome__read_console_messages({
  tabId: <editor-tab-id>,
  pattern: "error|warn|uncaught",
  onlyErrors: false,
})
```

If `readNetworkRequests` is needed to debug API failures, also call:

```ts
mcp__Claude_in_Chrome__read_network_requests({
  tabId: <editor-tab-id>,
  urlPattern: "/api/",
})
```

What to surface:
- New `tag: "mcp"` entries with the relevant tool names — confirms the agent took the right tool path
- Errors/warnings in libi.log → server-side issues
- `[browser] Uncaught Error` lines in `server.log` → React errors relayed to Next.js
- Console errors from `read_console_messages` → UI issues NOT relayed (CSS, focus loops, etc.)
- Failed API calls from `read_network_requests` → contract bugs between UI and backend

## Step 5 — Read the agent's actual response (not just tool calls)

Tool calls landing is necessary but not sufficient — the agent also has to
*say* the right thing back to the user. Pull the session transcript:

```bash
# 1. Find the most recent session from the agent's CLI history
curl -s http://localhost:3456/api/sessions | jq '.sessions[0]'

# 2. Get its message history (endpoint shape may differ — verify against
#    the actual route in app/api/sessions/[sessionId]/* — the implementer
#    should pick whichever endpoint exposes the per-session message log)
curl -s http://localhost:3456/api/sessions/<sessionId>/messages | jq '.'
```

If no per-session-messages endpoint exists, fall back to scraping the chat
panel via `mcp__Claude_in_Chrome__get_page_text` or `read_page` — the
rendered chat bubbles ARE the agent's response.

What to look for in the transcript:
- Does the agent **explain its reasoning** (which skill, why this tool)?
- Does it **show the user the result** (e.g., for `create_character`, the rep image inline as markdown)?
- Does it **ask for confirmation** at the right disambiguation points?
- Does it **acknowledge limitations** (e.g., "this is a placeholder run because fake-ai-assets is the only generation MCP")?

A clean tool-call sequence with a confused or terse user-facing reply means
the skill's *behavior contract* is missing — patch the SKILL.md.

## Step 6 — Take final screenshot + assess

When the agent stops generating:

1. `mcp__Claude_in_Chrome__computer` action `screenshot` — share the result
2. Pull the last 50 lines of each log
3. Pull the final browser console state via `read_console_messages`
4. Report to the user:
   - **What worked**: which skill the agent loaded, what tools it called, final state, what the agent said
   - **What didn't**: missing tool calls, wrong tool choices, server errors, browser errors, weak agent responses
   - **Skill gaps**: if the agent took the wrong path or said the wrong thing, point at the SKILL.md line that needs to be tightened
   - **UI bugs**: anything in browser console / network failures

## Step 7 — Optional re-run after fix

If gaps were found and the user wants to fix the skill:

1. Edit the relevant SKILL.md
2. Ask the user to restart `LIBI_TEST_MODE=1 npx libi` (skills are reloaded via the workspace writer at startup)
3. Re-run from Step 3 with the same prompt
4. Compare behavior

## Stop conditions

Stop and ask the user before continuing if:
- Test mode is not active and the user hasn't responded to the restart prompt
- The agent has been "generating" for >3 minutes with no log activity (likely stuck)
- Any tool returns an error that would corrupt user data (file deletion, DB write)
- The browser shows persistent console errors that block the UI from rendering

## Reusability notes

This command is designed to be invoked many times across many future features
— don't bake feature-specific details into the body. The git-diff-based
focus-inference (Step 2) keeps it generic. When you find that a particular
class of feature needs a custom prompt template, add it as a bullet under
the "Step 2 examples" list — don't fork the command.
