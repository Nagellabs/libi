---
id: memories-update
title: Memories loop — consent-first update_memories lands in memories.md
surfaces: [terminal, acp, connect-agent]
agents: [claude-code, codex]
systems: [instructions-memories, notify-instructions-changed, workspace-regen]
cost: subscription-tokens
---

## Preconditions
- Note the current content of `~/.libi/memories.md` (may not exist yet).

## Prompt
> Remember for the future: I prefer 9:16 vertical format for all my videos
> unless I say otherwise.

## Expected behavior
- Agent asks for consent before persisting (consent-first contract), then
  calls `libi.update_memories` with mode `append`.
- The server fires `notify.instructionsChanged()` → `regenerateAndRestart()`:
  workspace instruction files re-emit with the memory included; ACP sessions
  restart (banner in chat); **terminal sessions must survive untouched**.

## Checks
- [ ] Agent asked before saving (didn't silently persist).
- [ ] `~/.libi/memories.md` now contains the 9:16 preference.
- [ ] Workspace instructions re-emitted: the `## Memories` section between
      `<!-- libi-memories-start/end -->` markers in `~/.libi/agent/CLAUDE.md`
      includes it.
- [ ] Instructions page (`/instructions` → Memories tab) shows the entry.
- [ ] **Terminal session survived** the regen (the PTY and the inner Claude
      Code process were NOT killed — only ACP sessions restart).
- [ ] Memories cap respected: file remains under 8000 chars.

## Cleanup
- Remove the test memory line via the Memories tab (or leave it if the user
  actually wants it — confirm with them).

## Notes
- The terminal-survival check is terminal-surface-specific and load-bearing:
  `regenerateAndRestart()` terminates ACP sessions; a regression that also
  reaps PTYs would silently kill the user's live CLI mid-conversation.
