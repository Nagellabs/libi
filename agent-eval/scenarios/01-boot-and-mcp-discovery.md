---
id: boot-and-mcp-discovery
title: Terminal session boots the CLI agent and it discovers the libi MCP
surfaces: [terminal, connect]
agents: [claude-code, codex]
systems: [pty-spawn, mcp-http-aggregator, libi-connect]
cost: subscription-tokens
---

## Surface notes
- On `connect`: replace the PTY/terminal steps (1–3) with the `connect` flow
  below (see scenario 11 for full preconditions and checks: `claude mcp
  add`/`codex mcp add` registered libi's HTTP endpoint, skills were mirrored,
  no CLAUDE.md/AGENTS.md/config files are written).

## Preconditions
- libi dev server running (`npm run dev`), app open in browser.

## Steps — HTTP aggregator sanity
1. With libi running, confirm the aggregator child is up:
   `cat ~/.libi/mcp-port` (or the worktree's `LIBI_HOME`) prints a port
   number, and `curl -s http://127.0.0.1:$(cat ~/.libi/mcp-port)/healthz`
   returns a JSON body listing the upstream MCPs (bundled + libi's own).

## Steps — in-app agent (ACP)
2. Sidebar agent selector → **Terminal** or the in-app chat surface, CLI
   preset = **Claude Code**; start a session.
3. Ask the agent: *"List the MCP servers and tools you have available. Just
   the names."*

## Expected behavior — in-app
- The in-app agent has exactly ONE libi MCP entry, reached over HTTP at
  `http://127.0.0.1:<port>/mcp?agent=claude` (or `?agent=codex`), carrying the
  `x-libi-surface: in-app` header — not a stdio server, not a per-folder
  config file.
- `libi.*` tools are visible (e.g. `libi.list_pieces`, `libi.create_piece`),
  including `libi.show_in_chat` (proves the in-app surface, not a plain
  `connect`-registered one).
- Bundled MCPs (e.g. YouTube Downloader) appear in the tool/server list too,
  proxied generically through the same aggregator.

## Steps — terminal WITHOUT `libi connect`
4. In a real terminal (not libi's embedded one), `cd` into a fresh temp
   folder that has never run `libi connect` and run `claude mcp list`.

## Expected behavior — no connect
- `libi` does NOT appear. A stock CLI in an unregistered folder has no way to
  discover libi — nothing is written to that folder and nothing is on PATH
  for it to find.

## Steps — `libi connect`
5. In that same temp folder, run `npx @nagellabs/libi connect` (libi must
   already be running, e.g. the `npm run dev` from above).
6. Run `claude mcp list` again.
7. Run a round trip: `claude -p "call libi.list_pieces and report what it
   returns"`.

## Expected behavior — after connect
- `claude mcp list` shows an entry like `libi … (HTTP) ✔ Connected` pointing
  at the same `http://127.0.0.1:<port>/mcp?agent=claude` endpoint (no
  `x-libi-surface: in-app` header this time).
- The `claude -p` round trip actually calls `libi.list_pieces` and returns a
  real result (proves a live HTTP round-trip, not just config parsing).

## Codex variant
8. Repeat steps 4–7 with `codex mcp list` / `codex exec` instead of
   `claude mcp list` / `claude -p`. Codex registration is **user-wide**
   (`codex mcp add`, not per-folder), so `codex mcp list` shows `libi` after
   connecting from any directory, and step 4's "not connected" check should
   be run before ANY folder has connected Codex on that machine.

## Checks
- [ ] `<LIBI_HOME>/mcp-port` exists and `/healthz` lists upstream MCPs.
- [ ] In-app agent tool listing includes `libi.show_in_chat` plus core
      `libi.*` tools and bundled MCP tools, all via the single HTTP entry.
- [ ] `claude mcp list` in a fresh, unconnected folder does NOT show `libi`.
- [ ] After `npx @nagellabs/libi connect`, `claude mcp list` shows
      `libi … (HTTP) ✔ Connected`.
- [ ] `claude -p` round trip successfully calls `libi.list_pieces`.
- [ ] Codex: `codex mcp list` shows `libi` (user-wide) after connect.

## Notes
- If `libi` is missing from the in-app agent's tool list: check
  `~/.libi/mcp-port` was written and the `serve-mcp-http` child started
  (`tag: "mcp-http"` in `~/.libi/logs/libi.log`).
- If `libi connect` doesn't show up in `claude mcp list`/`codex mcp list`:
  check `lib/codex-config/` / the Claude Code registration path ran without
  error and that libi was actually running (reachable) at connect time.
