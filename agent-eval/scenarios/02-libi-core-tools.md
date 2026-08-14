---
id: libi-core-tools
title: Core libi tools work — create a piece, list pieces and files
surfaces: [terminal, acp, connect-agent]
agents: [claude-code, codex]
systems: [mcp-core-tools, sqlite, storage]
cost: subscription-tokens
---

## Preconditions
- Scenario 01 passed (agent connected to libi MCP).

## Prompt
> Create a new piece called "Agent Eval Run" with description "connectivity
> test piece". Then list all pieces and tell me which one is currently opened.
> Then list the files in the new piece.

## Expected behavior
- Agent calls `libi.create_piece` → `libi.list_pieces` → `libi.list_files`
  with the new pieceId, and reports results without errors.

## Checks
- [ ] `create_piece` succeeds and returns a full piece record (agent quotes an id).
- [ ] `list_pieces` includes "Agent Eval Run" AND reports `openedPiece`
      consistent with the editor.
- [ ] `list_files` on the new piece returns an empty list (not an error).
- [ ] The piece appears in the libi UI (Resources tree / piece list) without
      a manual reload — SSE `refresh_query` reached the client.
- [ ] DB row exists: `sqlite3 ~/.libi/libi.sqlite "select name from pieces
      order by created_at desc limit 3;"` shows the piece.

## Notes
- This piece is reused by scenarios 03–05 — don't delete it.
- If tools error with `libi_server_unavailable`: the MCP child can't reach the
  Next server — check `~/.libi/port` and the jobs-client HTTP path.
