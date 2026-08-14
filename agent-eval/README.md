# Agent-Eval — manual connectivity evals per agent surface

End-to-end **system-connectivity** evals for libi's agent surfaces. Where
`skill-eval/` is an automated harness that judges *skill behavior* against the
fake-fal trace, `agent-eval/` checks that the **plumbing between a real agent
and libi works at all**: MCP discovery, tool round-trips, bundled MCPs,
navigation events, file flows, skill loading, approval flows.

These runs are **driven by a human or a development agent** (Claude Code in
this repo driving the app UI), not by an automated runner. Each scenario is a
script of what to type and what to observe.

## Surfaces × agents

A "run" is one (surface, agent) combination over the scenario set:

| Surface | How the agent connects | Agents |
|---|---|---|
| `terminal` | Embedded PTY terminal (Terminal surface in the sidebar); CLI discovers libi via `.claude/settings.local.json` in `~/.libi/agent/` | claude-code, codex, any preset CLI |
| `acp` | In-app chat via ACP (`claude-agent-acp` / `codex-acp`); MCP servers passed via `newSession({ mcpServers })` | claude-code, codex |
| `connect-agent` | Stock CLI launched in a directory *outside* libi; libi booted `npx @nagellabs/libi --connect-agent <dir>`; CLI discovers libi via that dir's `.mcp.json` + `.claude/settings.local.json` + skills mirror | claude-code, codex, any stock CLI |
| (future) | New surfaces/agents get a column here; scenarios are surface-agnostic unless marked | |

Each scenario's frontmatter lists which surfaces/agents it applies to. Most
apply everywhere — that's the point: the same connectivity must hold per
surface.

## How to run

1. Boot libi from this repo: `npm run dev` (NOT `next dev` — Category A must
   run). For zero-cost generation flows you may boot with `LIBI_TEST_MODE=1`,
   but the default for agent-eval is **production mode** — the generation
   scenario stops at the approval ask and declines, so nothing is spent.
2. Open the app, switch the sidebar agent selector to the surface under test
   (e.g. **Terminal**, preset = Claude Code), start a session.
3. Walk the scenarios in `TEST-PLAN.md` order (early scenarios create state
   later ones reuse). For each: type the prompt, observe, mark every check
   pass/fail.
4. Record results in
   `docs-local/from-repo/agent-eval/runs/<YYYY-MM-DD>-<surface>-<agent>/RESULTS.md`
   (one line per check; transcript snippets for failures). That directory is
   gitignored — machine-local QA notes, not tracked product docs — so it
   won't exist until your first run creates it.
5. Small issues: fix as you go, note the fix in RESULTS.md. Big issues: file
   them in `docs-local/from-repo/agent-eval/FOLLOW-UPS.md` with enough context
   to plan a fix later — do not rabbit-hole mid-run.

## Conventions

- Scenario files: `scenarios/NN-<slug>.md`, numbered in intended run order.
- Frontmatter: `id`, `title`, `surfaces`, `agents`, `systems` (which
  connectivity layer it covers), `cost` (`free` | `subscription-tokens` |
  `paid-declined`).
- Checks are written as observable facts (UI state, filesystem, log lines,
  DB rows) — never "the agent seemed fine".
- One scenario per system is enough (e.g. ONE bundled MCP, ONE skill load);
  these are connectivity probes, not coverage matrices.
