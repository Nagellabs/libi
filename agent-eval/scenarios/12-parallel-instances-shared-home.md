---
id: parallel-instances-shared-home
title: Two libi instances (normal + connect-agent) share one Libi Home
surfaces: [connect-agent]
agents: [claude-code]
systems: [multi-instance, port-file, shared-db, sse]
cost: subscription-tokens
---

## Preconditions
- Instance A already running normally (`npm run dev`) with home `$LIBI_HOME_A`
  (in worktree dev: the bootstrap-assigned home — read it from the boot log).
- Note: instance B MUST share that home: boot with
  `LIBI_HOME=$LIBI_HOME_A npm run dev -- --connect-agent /tmp/libi-connect-eval --port <portA+1>`.

## Steps
1. Boot instance B alongside A.
   - [ ] Both respond on their ports (`curl -s localhost:<portA>/api/sessions`,
     same for B).
   - [ ] No DB-lock or migration errors in either `server.log` / `libi.log`.
2. In the connected CLI (tmux, talking through instance B): create a piece and
   upload a small file.
   - [ ] Piece + file rows exist in the shared SQLite.
   - [ ] Instance A's UI shows the new piece (manual refresh allowed).
3. In instance A's UI chat: create a piece.
   - [ ] The connected CLI sees it via `libi.list_pieces`.
4. Record cross-instance event routing: `~/.libi/port` (under the shared home)
   is last-writer-wins, so MCP children POST `/api/notify` to whichever server
   wrote it last.
   - [ ] Note in RESULTS which instance received navigation/refresh events and
     whether the other needed manual refresh. If the observed behavior is
     confusing for a real user, file a FOLLOW-UP (per-instance port handoff /
     instance-scoped port files) — do NOT fix mid-run.
