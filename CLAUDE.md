@AGENTS.md

# Claude Code specifics

`AGENTS.md` (imported above) is the source of truth for this repo — commands, hard rules,
conventions, and the Electron/CDP workflow. Keep it short; add to it rather than to this
file. Everything below applies only to Claude Code.

## Never work directly on `main`

Branch first, always. `main` is what the public sees and what `release:electron`
verifies against — it is not a scratchpad.

- Start any change on its own branch, however small.
- When the work is finished and verified, **squash-merge** it into `main` as ONE
  commit, then push. One change, one commit, one message that explains it.
- Delete the branch afterwards.

Squashing matters beyond tidiness: it is also what gives the merged commit a
genuine timestamp at merge time, which the weekend-publishing policy depends on.

The one exception is a change the release path structurally requires on `main`
before it can run — `release:electron` refuses unless `HEAD` is an ancestor of
`origin/main`. Say so out loud when taking it.

This rule exists because the 2026-08-14 release went straight to `main` for eight
commits, including an experiment pushed on a theory that was disproven twenty
minutes later and reverted in the next commit. Both are permanent public history
now. A branch would have made that one reviewable commit, or none.

## Skills and commands

- `/feature-testing` (`.claude/skills/feature-testing/`) — the test-mode playbook. Force it
  after changes to MCP tools, skills, agent instructions, or any `libi.*` route.
- `/skill-eval` (`.claude/skills/skill-eval/`, canonical copy in `skill-eval/agent-skill/`)
  — runs the agent-driven scenarios. Token-costly; run only the scenarios a change
  warrants. Re-run `npm run skill:eval:index` after editing the canonical copy.
- `/windows-qa` (`.claude/skills/windows-qa/`) — building, installing and verifying a
  desktop build on the Windows QA VM. Read it BEFORE touching that machine; every rule
  in it is a failure that already happened, and most of them look like something else
  (a build that "succeeded" and shipped nothing, an app that reads as uninstalled, a
  crash that is really session 0). Host details live in
  `docs-local/release/windows-qa-runbook.md`.
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

## Releases

`docs-local/release/next-release.md` is the running queue for the next Friday/Saturday
window: what must be published (npm, Electron, or both), what to verify afterwards, and
a shipped log. **When a change lands that needs publishing, add it there in the same
turn** — a merged feature nobody queued is a feature that misses the window. Read it at
the start of any release, and empty it into the shipped log when the release is out.

A release is **two workflows** (see `AGENTS.md` → Desktop shell vs runtime):

1. **Release npm** — the release most weeks are. Ships the runtime, which reaches
   installed desktop apps on its own.
2. **Release electron** — only when `electron/` changed. Takes the published version as an
   input, so it can be re-run against that same version as often as needed.

Two consequences worth holding on to:

- **Rehearse the shells before publishing them.** `release-electron.yml` with
  `dry_run: true` builds both and uploads the artifacts without cutting a Release. Use it
  after ANY change to the shell jobs or `release-electron.js` — that is the whole reason
  the workflows are split, and it costs nothing.
- **Recovery differs by cause.** A transient failure (notarization is a network
  round-trip) takes *Re-run failed jobs*. A failure whose fix lands in code takes a fresh
  dispatch, because the shell jobs check out the TAG and a re-run would build the same
  unfixed commit.

## After a release

Verify the *published* artifacts as a fresh user would receive them — not the working
tree. The procedure is `docs-local/release/release-verification-playbook.md` (local to
this machine): the SMALL tier (~30 min — artifact integrity, npx cold boot under a fresh
`LIBI_HOME`, dmg fresh boot, one agent round-trip) for routine releases, FULL when the
release touched install, provisioning, onboarding, or agents. Never run QA against
`~/.libi` (npx shares it with this checkout), and judge the dmg by staple + mount + app
assessment. Note the old caveat here — "the container is unsigned by design, so
`spctl -t open` always rejects it" — **stopped being true in v0.1.2**: `dmg.sign: true`
ships, the container is signed, separately notarized and stapled, and v0.1.2 assessed
`accepted / source=Notarized Developer ID`. A rejection is now a real finding.
