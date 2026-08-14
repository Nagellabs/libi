---
id: skill-loading-ugc
title: Bundled skills load — a UGC ad request triggers the ugc-product-video skill
surfaces: [terminal, acp, connect-agent]
agents: [claude-code, codex]
systems: [skill-mirror, skill-discovery, skill-invocation]
cost: subscription-tokens
---

## Preconditions
- Scenario 01 passed. `~/.libi/agent/.claude/skills/` contains the mirrored
  bundled skills (flat: `<name>/SKILL.md`) — spot-check `ugc-product-video/`
  exists before prompting.

## Prompt
> I want to create a short UGC-style product ad for a hand cream brand.
> Before doing anything, tell me your plan and which skill or workflow you're
> following — don't generate anything yet.

## Expected behavior
- The agent discovers and loads the `ugc-product-video` skill (Claude Code
  surfaces skill use; the plan should mirror the skill's staged workflow —
  product analysis, script, asset generation stages, snapshot/draft, etc.).
- Because the prompt forbids generation, the agent stops at the plan. No
  fal-ai calls.

## Checks
- [ ] Agent's plan names or unmistakably follows `ugc-product-video` (stage
      structure from the skill, references to its workflow — not a generic
      ad-hoc plan).
- [ ] Claude Code's transcript shows the skill/SKILL.md being read or invoked.
- [ ] No generation tool was called (no fal-ai activity, no new files).
- [ ] Cross-skill reference intact: the plan reflects `ai-asset-generation` /
      model-selection guidance the ugc skill chains to (e.g. mentions image →
      video staging or model choices), evidence the skill graph resolved.

## Notes
- One skill is enough — this probes the skill-loading SYSTEM, not skill
  quality (skill-eval owns behavior depth).
- If the skill never loads: check the writer mirror (`mcp/skills/writer.ts`)
  output in the workspace, and that the skill is enabled in the DB.
