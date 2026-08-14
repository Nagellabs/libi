---
name: feature-testing
description: Verify libi features end-to-end via the actual libi agent in test mode (LIBI_TEST_MODE=1 npx libi — fal-ai is swapped for a fake that mirrors the real tool surface with placeholder outputs) before declaring agent-facing work complete. Use after changes to MCP tools, skills, agent instructions, or any libi.* route.
---

# Feature Testing (Dogfood Verification)

Libi's primary user is the **agent**. Unit tests prove logic; this skill
verifies the *experience* — does the agent actually pick the right tool,
follow the right skill, and produce a sensible result when the developer's
change lands?

## When this skill applies

Apply after editing any of:
- MCP tool definitions or schemas (`mcp/tools/*.ts`, `mcp/tools/schemas.ts`, `mcp/server.ts`)
- Skill content (`mcp/skills/<name>/SKILL.md`)
- Agent instructions (`mcp/templates/instructions.md`, `mcp/instructions.ts`, `mcp/registry/instruction-builder.ts`)
- REST or SSE routes the agent reads or writes (`app/api/*`)
- Any `libi.*` behavior that the user could trigger via chat

If you finish a task in any of these areas without running this flow, the
work is not actually verified — only the unit tests are.

## The flow

1. **Check whether the user's dev server is in test mode**
   - Read `~/.libi/logs/server.log` (last ~50 lines) — look for "Loaded N sessions" AFTER a recent restart, AND for the TEST MODE banner in the agent instructions output
   - OR query `GET /api/settings/mcp-servers` — `fal-ai` will still be listed (it's present as the fake), but the server's spawn command will point at `mcp/dev/fake-fal/`. In test mode, `LIBI_TEST_MODE=1` is visible in the process environment and the agent's instructions contain a TEST MODE banner. You can confirm by checking `~/.libi/test-mode/fal-calls.jsonl` — it will exist (and grow) only while the fake is active.

2. **If not in test mode, ask the user to restart**
   > "I need to verify this end-to-end through the agent. Can you stop the dev server and run `LIBI_TEST_MODE=1 npx libi`? That swaps fal-ai's transport to the fake-fal MCP (same tool surface, placeholder outputs) and adds a TEST MODE banner to the agent's instructions."

   Wait for explicit confirmation that the restart is done. Do NOT run `LIBI_TEST_MODE=1 npx libi` yourself — it would block on the foreground server process.

3. **Use the Claude in Chrome MCP to drive the UI**
   - `mcp__Claude_in_Chrome__tabs_context_mcp` (createIfEmpty: true)
   - `mcp__Claude_in_Chrome__navigate` to `http://localhost:3456/editor`
   - `mcp__Claude_in_Chrome__find` for the "New chat" button → click
   - `mcp__Claude_in_Chrome__find` for the chat composer textarea → type the test prompt → press Return

4. **Choose a test prompt that exercises the changed surface**

   For a tools/skills change in the catalog area:
   > "List the characters in my library, then save a fictional product called 'AquaFlow' (sleek aluminum bottle, glowing blue cap) as an item."

   For a UGC/composition change:
   > "Create a 15-second UGC ad for a fictional product 'AquaFlow'. Catalog it as an item, generate 3 hero shots and 1 product video, build the composition, render a preview."

   For an analysis-pipeline change:
   > "Analyze [some uploaded video], catalog any people you see as characters, summarize."

5. **While the agent runs, monitor everything in parallel:**
   - `tail -f ~/.libi/logs/server.log` (Next.js framework errors, request lines, `[browser]` relayed React errors)
   - `tail -f ~/.libi/logs/libi.log | jq 'select(.tag != "ffmpeg")'` (every MCP tool call by tag)
   - `mcp__Claude_in_Chrome__read_console_messages` periodically (UI/JS errors NOT relayed via Next)
   - `mcp__Claude_in_Chrome__read_network_requests` if API failures suspected

6. **Pull the actual agent response, not just the tool calls.** Tool calls landing tell you the *right tool fired*; the chat transcript tells you whether the agent *said the right thing*. Use the libi sessions API (`/api/sessions/<sessionId>/messages` or whatever the per-session message endpoint exposes — verify the route shape) OR scrape the chat panel via `mcp__Claude_in_Chrome__get_page_text`. The agent's user-facing reply is part of what you're verifying.

7. **Take a screenshot at completion** with `mcp__Claude_in_Chrome__computer screenshot`. The result is your evidence the change works (or doesn't).

## What to look for

- **Skill loading** — did the agent read the right skill? You'll see the skill name in the agent's reasoning if it's verbose, or you can ask "which skill did you use here?"
- **Tool sequence** — does it match the workflow documented in the SKILL.md? Or did it shortcut?
- **Disambiguation** — when there's ambiguity (multiple matches, missing context), does it ask vs. guess?
- **Error handling** — when a tool returns `{ error }`, does the agent recover or panic?
- **Output quality** — did the composition / preview / file actually appear?

## Identifying skill gaps

If the agent picks a wrong tool, asks redundant questions, or skips a step,
**the skill is the bug — not the agent.** Patch the relevant SKILL.md to be
more explicit, restart the dev server (test mode), re-run the same prompt,
verify the fix.

Common failure patterns and what to fix:

| Symptom | Likely fix |
| --- | --- |
| Agent refuses to call `fal-ai.*` tools, says "no real provider" | TEST MODE banner needs to be clearer that `fal-ai` is present as the fake — calling it is correct behavior |
| Agent generates placeholder but tells user "output is a placeholder" without being asked | Expected behavior in test mode; only a concern if the user is confused — check if the TEST MODE banner wording is calibrated |
| Agent skips cataloging a recurring subject | `using-character-library` workflow trigger conditions are too loose |
| Agent doesn't show representative image after `create_character` | The "always show rep image" requirement was implicit; make it explicit in the skill |
| Agent guesses at multiple disambiguation candidates | Skill needs a "render a numbered list and ASK" step |
| Agent panics on tool error | Tool description needs a "what to do if this errors" sentence |

## What this skill does NOT cover

- Real AI quality regressions — fake assets prove the pipeline, not the model output
- Production performance — the fake-fal server returns in <1s, real generation is 10-60s
- Rate-limit / cost behavior — none of that exists in test mode
- Cross-platform issues that only manifest in packaged Electron builds

For those, run a small batch on real credits OR use the production app.

## Slash command

If you want to force this workflow at any time, run `/feature-testing` —
that command file (`.claude/commands/feature-testing.md`) walks you through
the steps actively.
