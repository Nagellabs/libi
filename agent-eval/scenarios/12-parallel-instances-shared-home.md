---
id: parallel-instances-shared-home
title: Two libi instances share one Libi Home; each runs its own MCP aggregator
surfaces: [connect]
agents: [claude-code]
systems: [multi-instance, mcp-http, port-file, shared-db, sse]
cost: subscription-tokens
---

## Preconditions
- Instance A already running normally (`npm run dev`) with home `$LIBI_HOME_A`
  (in worktree dev: the bootstrap-assigned home — read it from the boot log).
- Instance B is a SECOND normal instance sharing that home, on a different
  port: `LIBI_HOME=$LIBI_HOME_A npm run dev -- --port <portA+1>`. There is no
  boot-time connect flag any more — every instance is the same kind of
  instance, and each one boots its OWN `serve-mcp-http` aggregator. The
  aggregator port is NOT derived from the studio port: whichever instance
  starts first takes the fixed default 3457, and the other falls back to its
  own studio port + 1 (then any free port). Never assume a number — each
  instance writes the port it actually bound to `<LIBI_HOME>/mcp-port`, and
  because the home is SHARED that file is last-writer-wins, so read each
  aggregator's port from the instance's own boot log
  (`libi.log`, tag `mcp-http`, `op` `child_ready` / `port_repicked`).

## Steps
1. Boot instance B alongside A.
   - [ ] Both respond on their ports (`curl -s localhost:<portA>/api/sessions`,
     same for B).
   - [ ] No DB-lock or migration errors in either `server.log` / `libi.log`.
   - [ ] Each instance's aggregator answers its OWN `/healthz` — take each
     aggregator port from that instance's `mcp-http` log lines (see
     Preconditions), then
     `curl -s http://127.0.0.1:<aggPortA>/healthz` and `<aggPortB>/healthz`.
     Two aggregators, two DIFFERENT ports, same shared home. One of the two
     should be 3457; the other must not be, and a `port_repicked` line is a
     pass, not a failure.
2. Under the shared home, `<LIBI_HOME>/mcp-port` is last-writer-wins: whichever
   instance (A or B) started or restarted its aggregator most recently owns
   the file.
   - [ ] Note which instance currently owns `<LIBI_HOME>/mcp-port`.
3. From a scratch dir, `npx @nagellabs/libi connect` reads that file — it
   registers whichever instance is currently reflected there, not necessarily
   the one you meant.
   - [ ] `claude mcp list` in the scratch dir shows the `libi` HTTP entry
     pointing at the port instance recorded in step 2.
   - [ ] Create a piece through that connected CLI; confirm the row lands in
     the shared SQLite and is visible from BOTH instances' UIs (manual
     refresh allowed on the one that didn't emit the SSE event).
4. Restart the OTHER instance (whichever step 2 did not name) so it rewrites
   `<LIBI_HOME>/mcp-port`, then re-run `npx @nagellabs/libi connect` in the
   same scratch dir.
   - [ ] The registration flips to the new port — `libi connect` always
     targets whichever aggregator most recently claimed the port file, not a
     fixed instance.
   - [ ] If this hand-off is confusing for a real user running two instances
     on purpose, file a FOLLOW-UP (per-instance port scoping) — do NOT fix
     mid-run.
