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
  (short prompts) and nothing is spent on generation: no scenario in the set
  runs a paid provider tool. The generation-approval scenario that used to
  cover that was deleted with libi's managed fal-ai MCP — libi manages no
  provider now, so a paid call belongs to the user's own MCP, not to this set.
- First launch inside `~/.libi/agent/` may show Claude Code's directory-trust
  prompt and MCP/tool permission prompts. Answering those IS part of the test
  (scenario 01).

## Run order

Scenarios are ordered so earlier ones create the state later ones reuse
(one piece, one uploaded video). Run top to bottom.

| # | Scenario | System under test | Cost |
|---|---|---|---|
| 01 | `01-boot-and-mcp-discovery.md` | PTY spawn, libi's HTTP MCP aggregator (`serve-mcp-http`), `libi connect` registration | tokens |
| 02 | `02-libi-core-tools.md` | Core tool round-trip: `create_piece`, `list_pieces`, `list_files` + DB | tokens |
| 03 | `03-navigation-show-piece.md` | MCP child → `POST /api/notify` → SSE → editor navigation | tokens |
| 04 | `04-file-upload.md` | `upload_file` from local path, storage, proxy-gen job, SSE `refresh_query` | tokens |
| 05 | `05-background-job-progress.md` | `runJobViaServer` HTTP+SSE jobs bridge (`trim_video`), Jobs UI | tokens |
| 07 | `07-skill-loading-ugc.md` | Skill mirror discovery (`<workspace>/.claude/skills/`), ugc-product-video loads | tokens |
| 09 | `09-skill-creation.md` | `libi.add_skill` → DB row + workspace re-mirror + Skills UI | tokens |
| 10 | `10-memories-update.md` | `update_memories` consent flow → `memories.md` → instructions regen | tokens |
| 11 | `11-connect-folder.md` | `libi connect` registration + skills mirror in a folder outside libi, without touching the user's own files | tokens |
| 12 | `12-parallel-instances-shared-home.md` | Two instances on one Libi Home: one MCP aggregator each, port file, shared DB, SSE | tokens |

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

## connect runs (surface = `connect`)

- Scratch dir: `/tmp/libi-connect-eval`, seeded BEFORE running `libi connect`
  with guard probes:
  - a decoy `CLAUDE.md` (`# My project notes` + one rule) — libi never writes
    CLAUDE.md/AGENTS.md any more, so this must come back byte-identical;
  - a decoy user skill `.claude/skills/my-own-skill/SKILL.md`;
  - an old-style `.mcp.json` holding two entries: `libi` (a leftover stdio
    entry from before the MCP-over-HTTP migration) and `mine` (a user's own
    server) — `libi connect` must remove only the `libi` entry and leave
    `mine` untouched.
- Boot: a normal libi instance (`npm run dev`, or `npx @nagellabs/libi`) —
  boot doesn't target the scratch dir at all any more. Then, separately, from
  the scratch dir: `npx @nagellabs/libi connect` (worktree bootstrap gives the
  instance an isolated home + port as usual; `connect` reads
  `<LIBI_HOME>/mcp-port` to find it).
- Driver: a real INTERACTIVE `claude` inside tmux — `tmux new-session -d -s
  connect-eval -c /tmp/libi-connect-eval`, then `tmux send-keys` to type and
  `tmux capture-pane -p` to read. No `claude -p` (print mode is moving to
  metered credit; interactive is the supported posture). A human can run the
  identical scenarios by hand in any terminal.
- Scenario 01's "PTY spawn" checks become scenario 11's checks: `claude mcp
  add`/`codex mcp add` registered libi's HTTP endpoint (`claude mcp list` /
  `codex mcp list` show it), the skills mirror + `.libi-managed.json` landed,
  and the decoy `CLAUDE.md` + `.mcp.json`'s `mine` entry are untouched.
- Scenario 11 is connect-only. Scenario 12 (parallel instances) is also
  connect-only — but now covers TWO ordinary instances sharing a Libi Home,
  each running its own `serve-mcp-http` aggregator on its own port, with
  `libi connect` registering whichever one currently owns
  `<LIBI_HOME>/mcp-port`.
