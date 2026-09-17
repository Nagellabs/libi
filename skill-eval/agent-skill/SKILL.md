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
3. **Read the verdict.** The CLI prints per-run `HARD-PASS` / `NO-ASSERTIONS` /
   `FAIL` / `TIMEOUT` and a `JSON_SUMMARY` line. Hard invariants are mechanical —
   already decided. **`NO-ASSERTIONS` is not a pass you can report as one:** that
   scenario declares no invariants, so it passed on `every([]) === true` and the
   verdict means only "the run completed". Roughly half the library is in that
   state (the `invariants` column in `INDEX.md` says which). For those, step 4 is
   the ONLY evidence there is — never write "N scenarios passed" over a set that
   includes them without saying how many asserted nothing.
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

Three optional frontmatter keys change what the run itself can do:

- **`share: [bin, models]`** — COPY those subtrees of the real `~/.libi` into the
  scenario's hermetic home, so a scenario can reach `uv` or local model weights.
  Opt-in, and a copy rather than a link, so the run cannot write back into your
  Libi Home. Leave it off to assert the `needs_install` path.
- **`fixtures: [<repo-relative path>, …]`** — stage real media into
  `<home>/fixtures/` before boot, and refer to it from the prompt as
  `{{fixture:<basename>}}`, which resolves to the staged absolute path. This is how
  a scenario that needs INPUT media (a transcript, captions, anything reading an
  existing clip) gets any: the harness creates an EMPTY piece and seeds nothing.
  Paths must be repo-relative and inside the repo, and a typo fails before the
  server is spawned.
- **`preauthorize: false`** — see the preamble note below. Use it when the
  behaviour under test is that the agent does NOT spend.

`transcript_contains` matches a substring of the rendered transcript rather than the
fal/ElevenLabs trace — the only mechanical way to assert on a `libi.*` call, which never
reaches `fal-calls.jsonl`. A tool call renders as `[tool-call mcp__libi__libi_foo] {args}`,
so match that literal. It cannot be combined with a trace selector, and it is a blunt instrument:
prefer an `endpoint_id` assertion whenever the behaviour you care about is a generation.

## How a run drives the agent (so your matchers are robust)

- **Runs are unattended.** The harness sets the agent's approval mode to
  `auto-with-generations` and, by default, appends a pre-authorization preamble to
  the prompt, so the agent runs the whole workflow to completion without pausing for
  the "OK to generate?" cost gate. Under that default this harness CANNOT test "does
  the agent pause to ask before X?" — that behaviour is suppressed by design, so test
  model/param CHOICES, not approval-pausing.
- **…unless the scenario sets `preauthorize: false`.** That swaps the preamble for
  one that forbids spending the user's money, honours the product's own disclosure
  gates, and states that stopping at the "may I?" question is the CORRECT outcome of
  the run. It is the only way to assert a paid call is ABSENT: under the default
  preamble an agent has reasoned correctly that the paid route was opt-in only and
  then taken it anyway, citing the pre-authorization
  (`skill-eval/runs/2026-09-09T07-43-59-179Z`). Use it for free-before-paid and
  no-silent-spend behaviour, and for nothing else — a scenario that needs to reach a
  generation must keep the default or it will simply stop at the question.
  Worked example: `skill-eval/scenarios/music-creation/02-free-before-paid.md`.
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
