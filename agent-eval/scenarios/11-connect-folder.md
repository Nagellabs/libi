---
id: connect-folder
title: libi connect registers the endpoint and mirrors skills without touching user files
surfaces: [connect]
agents: [claude-code, codex]
systems: [mcp-http, skills-mirror-ownership, cli-connect]
cost: subscription-tokens
---

## Preconditions
- libi running (dev or npx). Scratch dir `/tmp/libi-connect-eval` seeded BEFORE
  connect with a decoy `CLAUDE.md` (`# My project notes` + one rule), a user skill
  `.claude/skills/my-own-skill/SKILL.md`, and an old-style `.mcp.json` holding
  `libi` (stdio) plus `mine` (a user server).

## Steps
1. `cd /tmp/libi-connect-eval && npx @nagellabs/libi connect`
   - [ ] Output shows ✓ claude, ✓ codex, ✓ skills, and the legacy line naming `.mcp.json`.
   - [ ] `CLAUDE.md` is byte-identical to the decoy (libi never touches it).
   - [ ] `.mcp.json` contains only `mine`.
   - [ ] `.claude/skills/my-own-skill/` intact; `.claude/skills/.libi-managed.json` lists only libi's skills.
   - [ ] `claude mcp list` (in that dir) shows `libi` as HTTP; `codex mcp list` shows `libi`.
2. In `claude` there: `/mcp` → libi connected. Ask "what libi pieces exist?" → tool call.
   Ask for a UGC product video → the `ugc-product-video` skill loads (transcript), fal tool called.
3. Same two prompts in `codex`.
4. Re-run `npx @nagellabs/libi connect` — idempotent, no errors, same file state.
5. `cd /tmp/other && claude` → `/mcp` does NOT list libi (folder scope holds).
