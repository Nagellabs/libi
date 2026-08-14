@AGENTS.md

# Claude Code specifics

`AGENTS.md` (imported above) is the source of truth for this repo — commands, hard rules,
conventions, and the Electron/CDP workflow. Keep it short; add to it rather than to this
file. Everything below applies only to Claude Code.

## Skills and commands

- `/feature-testing` (`.claude/skills/feature-testing/`) — the test-mode playbook. Force it
  after changes to MCP tools, skills, agent instructions, or any `libi.*` route.
- `/skill-eval` (`.claude/skills/skill-eval/`, canonical copy in `skill-eval/agent-skill/`)
  — runs the agent-driven scenarios. Token-costly; run only the scenarios a change
  warrants. Re-run `npm run skill:eval:index` after editing the canonical copy.
- Repo-specific MCP servers come from `.mcp.json`; launch targets from `.claude/launch.json`.

## Worktrees

Feature work belongs in a worktree under `.claude/worktrees/<name>/`. The shell cwd resets
between tool calls, so `cd` into the worktree before **every** dev launch — see the
worktree rule in `AGENTS.md`, it is the most common way to verify a fix that isn't running.

## Polling cadence

When polling a long-running libi agent flow (a UGC video build, real fal-ai generation),
use **short wakeups of 60–180s**, not the 1200s+ default. A frame-vision pass finishes in
2–4 minutes and each video generation is ~40–90s, so a 20-minute wakeup misses several
events worth reacting to. Pair the wakeup with a `Monitor` armed on
`~/.libi/logs/libi.log` so tagged events wake you immediately, and end the turn quickly
when nothing has changed.

## After a significant change

Update the tests that the change touches, cover any new code path, and keep
`docs-local/test-registry.json` in sync — then run `npm test` and report what it actually
printed (re-read the ABI trap in `AGENTS.md` → Testing before trusting the summary).
