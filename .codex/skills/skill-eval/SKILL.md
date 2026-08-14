---
name: skill-eval
description: Run libi's agent-driven skill-eval scenarios. Use after editing a bundled skill, MCP wiring, or agent instructions to verify the inner libi agent still behaves correctly (e.g. picks gpt-image-2, keeps native audio). Heavy + token-costly — run manually, only the scenarios a change warrants.
---

# Skill-Eval (behavioral regression tests for libi skills)

Libi's primary user is the **inner agent**. This harness boots a hermetic
`LIBI_TEST_MODE=1` libi, runs the inner agent against one `.md` scenario with
production-exact skill/MCP wiring, checks deterministic trace invariants against
fake-fal's recorded calls, and leaves the transcript for YOU to judge behavior.

## When to use

After editing any of: a bundled skill (`mcp/skills/<name>/SKILL.md`), MCP tool
surface/schemas, agent instructions (`mcp/templates/instructions.md`,
`mcp/instructions.ts`), or `lib/mcp-config.ts` wiring. If you changed one of
these and did NOT run the relevant scenario, the behavioral change is unverified.

## The loop

1. **Discover.** Open `skill-eval/INDEX.md`. Map your change to scenarios via the
   `covers` / `skills` columns (e.g. you edited `ai-asset-generation` → run every
   scenario whose `covers` includes a model id or `native-audio`). Heavy runs ⇒
   confirm the chosen set with the developer before running; never run the whole
   library blindly.
2. **Run** each chosen scenario:
   `npm run skill:eval -- skill-eval/scenarios/<group>/<file>.md`
   (add `--agent claude-code` to override; `--keep` to retain the temp LIBI_HOME).
3. **Read the verdict.** The CLI prints per-run `HARD-PASS` / `FAIL` / `TIMEOUT`
   and a `JSON_SUMMARY` line. Hard invariants are mechanical — already decided.
4. **Judge behavior YOURSELF.** Open `<reportDir>/transcript.md` and check each
   `## Behavioral expectations` bullet in the scenario. A failed hard invariant is
   an automatic fail regardless of behavior.
5. **Report.** Summarize pass/fail per scenario. For a hard failure, cite the
   offending JSONL line from `<reportDir>/trace.jsonl`. For a behavioral failure,
   **the skill is the bug, not the agent** — propose the SKILL.md edit, then re-run
   the same scenario to confirm.

## Adding a scenario

Create `skill-eval/scenarios/<skill-or-orchestration>/<NN>-<slug>.md` with
frontmatter (`id`, `title`, `skills`, `mcps`, `agent`, `covers`, optional `runs`,
`timeoutSec`), a `## Prompt`, an optional `## Hard invariants` ```yaml assertions```
block, and optional `## Behavioral expectations` bullets. Then regenerate the
index: `npm run skill:eval:index`. Matchers support `tool`, `endpoint_id` (glob
`*`), `where: "input.x == y"`, and `expect: present|absent` / `count: ">=1"`.

## How a run drives the agent (so your matchers are robust)

- **Runs are unattended.** The harness sets the agent's approval mode to
  `auto-with-generations` and appends a pre-authorization preamble to the prompt,
  so the agent runs the whole workflow to completion without pausing for the
  "OK to generate?" cost gate. Consequence: this harness CANNOT test "does the
  agent pause to ask before X?" — that behavior is suppressed by design. Test
  model/param CHOICES, not approval-pausing.
- **Assert endpoints, not tools.** The agent reaches a model via the sync
  `run_model` OR the async `submit_job` path nondeterministically across runs.
  Scope matchers to `endpoint_id` (+ `where` on input), NOT `tool`, or a scenario
  will pass on one path and falsely FAIL on the other.
- **Cost + time.** Each run boots a hermetic server (~18s) and drives a REAL
  inner-agent turn — image-only scenarios ~1.5 min, full UGC (image+video+assemble)
  ~3–5 min — spending real inner-agent (Claude Code) tokens. fal generation itself
  is free (test-mode placeholders). Run only the scenarios a change warrants.

## What it does NOT cover

Real AI quality (placeholders prove the pipeline, not model output), production
performance, cost/rate-limit behavior, and approval-pausing (auto-approved — see
above). Codex as the inner agent is not wired yet (claude-code only) — the
abstraction exists; a `--agent codex` run reports `unsupported_agent` until libi
wires it.
