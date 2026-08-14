---
id: skill-creation
title: Skill creation tool — agent saves a user skill and it lands everywhere
surfaces: [terminal, acp, connect-agent]
agents: [claude-code, codex]
systems: [skill-tools, skill-db, skill-writer-mirror, skills-ui]
cost: subscription-tokens
---

## Prompt
> Save a new skill for me named "agent-eval-probe": when I ask for a
> connectivity probe, list the pieces and report the libi version. Tag it
> "testing". Keep the skill body short.

## Expected behavior
- Agent composes a valid SKILL.md (frontmatter with name/description/tags +
  body) and calls `libi.add_skill`.
- The skill persists to the `skills` DB table (`source: "user"`), is written
  to `~/.libi/skills/agent-eval-probe/SKILL.md`, and the writer re-mirrors it
  into the workspace (`~/.libi/agent/.claude/skills/agent-eval-probe/SKILL.md`).

## Checks
- [ ] `add_skill` succeeds (agent confirms with the skill name).
- [ ] `~/.libi/skills/agent-eval-probe/SKILL.md` exists with the `testing` tag
      in frontmatter.
- [ ] Workspace mirror exists: `~/.libi/agent/.claude/skills/agent-eval-probe/SKILL.md`.
- [ ] Skill card appears in Settings → MCPs & Skills → Skills tab (source:
      user, tag chip "testing") without manual reload.
- [ ] Round-trip: in a NEW terminal session, ask *"run a connectivity probe"*
      — the new skill loads and the agent lists pieces + version.

## Cleanup
- Delete the probe skill afterwards (`libi.remove_skill` or the Skills UI) so
  it doesn't pollute the user's library — unless the run notes say keep it.

## Notes
- This also covers the self-improvement loop's storage half (the loop's
  behavioral side is skill-eval's `self-improvement` scenario).
