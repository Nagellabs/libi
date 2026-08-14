---
id: navigation-show-piece
title: Agent-driven navigation — show_piece moves the editor
surfaces: [terminal, acp, connect-agent]
agents: [claude-code, codex]
systems: [navigation-events, notify-http, sse]
cost: subscription-tokens
---

## Preconditions
- Scenario 02 created the "Agent Eval Run" piece.
- The editor is currently showing a DIFFERENT piece (or the home/empty state)
  so navigation is observable. If needed, manually open another piece first.

## Prompt
> Open the piece "Agent Eval Run" in my editor.

## Expected behavior
- Agent resolves the piece (via `list_pieces`) and calls `libi.show_piece`.
- The MCP child POSTs `/api/notify`; the server emits a navigation event over
  SSE; the editor panel switches to the piece — with no manual action.

## Checks
- [ ] Editor navigates to "Agent Eval Run" within ~2s of the tool call.
- [ ] No page reload occurred (SPA navigation via SSE, not refresh).
- [ ] `libi.log` shows the notify round-trip (`grep -i show_piece` /
      `tag: "mcp"` events around the call time).
- [ ] Follow-up: ask the agent to `libi.show_mcp_settings` — the app
      navigates to Settings → MCP Servers (second navigation kind works too).
- [ ] Navigate back to the piece afterwards (leave editor on "Agent Eval Run"
      for scenario 04).

## Notes
- This is the canonical "agent → UI" push path. If it fails, every show_*
  tool is broken: check `mcp/notify.ts` → `/api/notify` → `navigationEmitter`
  → `/api/agent/events` SSE → client handler chain.
- Per repo policy, navigation must be agent-driven only — confirm the editor
  did NOT auto-navigate during scenario 02 (creation alone must not move it).
