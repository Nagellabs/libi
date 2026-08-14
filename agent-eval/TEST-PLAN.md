# Agent-Eval Test Plan — BYO-CLI connectivity via the Terminal surface

**Goal:** verify that a real CLI agent (first run: Claude Code) launched inside
libi's new embedded Terminal surface has full working connectivity to every
libi system: core MCP tools, bundled MCPs, navigation events, file flows,
background jobs, skills, approval flows, and the instructions/memories loop.

**This run:** surface = `terminal`, agent = `claude-code`. The same scenario
set re-runs later for `terminal × codex` and `acp × {claude-code, codex}`.

## Environment

- Boot from the repo worktree: `npm run dev` (Category A must run; never
  `next dev`). Default LIBI_HOME (`~/.libi/`) so the real bundled MCPs,
  binaries, and the user's existing Claude Code login are in play — this is a
  production-fidelity connectivity test, not a hermetic one.
- Driver: a development agent (or human) controls the libi UI in a browser,
  types prompts into the embedded terminal, and observes the editor panels,
  `~/.libi/logs/libi.log`, and the filesystem.
- The inner Claude Code runs on the user's subscription. Token use is small
  (short prompts, no generation completes — scenario 08 declines at the
  approval ask).
- First launch inside `~/.libi/agent/` may show Claude Code's directory-trust
  prompt and MCP/tool permission prompts. Answering those IS part of the test
  (scenario 01).

## Run order

Scenarios are ordered so earlier ones create the state later ones reuse
(one piece, one uploaded video). Run top to bottom.

| # | Scenario | System under test | Cost |
|---|---|---|---|
| 01 | `01-boot-and-mcp-discovery.md` | PTY spawn, workspace `.claude/settings.local.json`, libi MCP stdio handshake | tokens |
| 02 | `02-libi-core-tools.md` | Core tool round-trip: `create_piece`, `list_pieces`, `list_files` + DB | tokens |
| 03 | `03-navigation-show-piece.md` | MCP child → `POST /api/notify` → SSE → editor navigation | tokens |
| 04 | `04-file-upload.md` | `upload_file` from local path, storage, proxy-gen job, SSE `refresh_query` | tokens |
| 05 | `05-background-job-progress.md` | `runJobViaServer` HTTP+SSE jobs bridge (`trim_video`), Jobs UI | tokens |
| 06 | `06-bundled-mcp-youtube.md` | Tier-2 bundled MCP spawn (yt-dlp via npx), binary dep, import round-trip | tokens |
| 07 | `07-skill-loading-ugc.md` | Skill mirror discovery (`<workspace>/.claude/skills/`), ugc-product-video loads | tokens |
| 08 | `08-generation-approval.md` | Paid-tool cooperative approval (fal-ai) — DECLINE at the ask | paid-declined |
| 09 | `09-skill-creation.md` | `libi.add_skill` → DB row + workspace re-mirror + Skills UI | tokens |
| 10 | `10-memories-update.md` | `update_memories` consent flow → `memories.md` → instructions regen | tokens |

## Issue handling policy

- **Small** (wrong copy, missing log, minor UX, an easy bug): fix immediately
  in the worktree, note fix + commit in RESULTS.md, continue.
- **Big** (architectural gap, broken flow needing design, cross-system bug):
  record in `docs-local/from-repo/agent-eval/FOLLOW-UPS.md` — symptom, repro,
  suspected layer, affected scenarios — and move on. Follow-ups later get
  their own plan (`docs-local/superpowers/plans/`).
- A scenario blocked by an earlier failure is marked `blocked`, not `fail`.

## Exit criteria

Every scenario marked pass / fail / blocked in
`runs/<date>-terminal-claude-code/RESULTS.md`, every fail either fixed
(small) or filed (big). No partial "ran most of it" runs.

## connect-agent runs (surface = `connect-agent`)

- Scratch dir: `/tmp/libi-connect-eval`, seeded BEFORE boot with guard probes:
  a decoy `CLAUDE.md` (`# My project notes` + one rule) and a decoy user skill
  `.claude/skills/my-own-skill/SKILL.md`.
- Boot: `npm run dev -- --connect-agent /tmp/libi-connect-eval` (worktree
  bootstrap gives an isolated home + port as usual).
- Driver: a real INTERACTIVE `claude` inside tmux — `tmux new-session -d -s
  connect-eval -c /tmp/libi-connect-eval`, then `tmux send-keys` to type and
  `tmux capture-pane -p` to read. No `claude -p` (print mode is moving to
  metered credit; interactive is the supported posture). A human can run the
  identical scenarios by hand in any terminal.
- Scenario 01's "PTY spawn" checks become: the connected dir contains
  `.mcp.json` with the libi entry, `.claude/settings.local.json` with
  `enableAllProjectMcpServers: true`, a marker-bracketed CLAUDE.md section,
  the skills mirror + `.libi-managed.json` — and the decoy files are intact.
- Scenarios 11–12 are connect-agent-only (update-path guards; parallel
  instances).
