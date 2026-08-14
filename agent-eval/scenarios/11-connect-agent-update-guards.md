---
id: connect-agent-update-guards
title: Live regeneration preserves user content in the connected dir
surfaces: [connect-agent]
agents: [claude-code]
systems: [agent-dir-merge, skills-mirror-ownership, config-regeneration]
cost: subscription-tokens
---

## Preconditions
- libi booted with `--connect-agent /tmp/libi-connect-eval`; the scratch dir
  was seeded BEFORE boot with the decoy `CLAUDE.md` and
  `.claude/skills/my-own-skill/` (see TEST-PLAN).
- Scenario 10 (memories update) just ran — `libi.update_memories` triggers
  `regenerateAndRestart`, which is the update path under test.

## Steps
1. Read `/tmp/libi-connect-eval/CLAUDE.md`.
   - [ ] The decoy content (`# My project notes` + rule) is still present
     OUTSIDE the markers.
   - [ ] Exactly one `<!-- libi-agent-start -->` … `<!-- libi-agent-end -->`
     section exists, and it contains the memory text saved in scenario 10.
2. List `/tmp/libi-connect-eval/.claude/skills/`.
   - [ ] `my-own-skill/` still exists with its original SKILL.md.
   - [ ] `.libi-managed.json` lists only libi-mirrored skill names
     (NOT `my-own-skill`).
3. Check the default agent dir (`<libi-home>/agent/CLAUDE.md`).
   - [ ] It was regenerated too (contains the new memory text) — the
     dual-target write covers both dirs.
4. In the tmux `claude` session, ask: "what do your instructions say about
   <the memory>?"
   - [ ] The agent picked up the refreshed instructions (new session reads the
     merged file).
