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
   (add `--agent claude-code` to override; `--keep` to retain the temp LIBI_HOME). An eval
   builds into its own Next dir, so it may run beside a dev app from the same checkout —
   but not beside another eval: two at once fight over that one dir and the second fails
   fast, naming the first's PID/Dir.
3. **Speed numbers, every run.** The harness copies the inner agent's Claude Code session log
   into `<reportDir>/agent-jsonl/` and writes `metrics.json` (API turns, tool calls by tool,
   input / cache-read / cache-write / output tokens deduplicated by message id, per-turn wall
   time); the verdict block prints an `agent:` line. `npx tsx scripts/skill-eval/bench-metrics.ts
   <runsDir>` tables any set of runs with medians. The speed benchmark is
   `_bench/dreams-six-pieces` (baselines in `docs-local/research/2026-10-03-speed-benchmark.md`).
4. **Read the verdict.** The CLI prints per-run `HARD-PASS` / `NO-ASSERTIONS` /
   `FAIL` / `TIMEOUT`, the run's wall time and (when the adapter reports it) the
   agent's session cost, and a `JSON_SUMMARY` line. Hard invariants are mechanical —
   already decided. **`NO-ASSERTIONS` is not a pass you can report as one:** that
   scenario declares no invariants, so it passed on `every([]) === true` and the
   verdict means only "the run completed". Roughly half the library is in that
   state (the `invariants` column in `INDEX.md` says which). For those, step 4 is
   the ONLY evidence there is — never write "N scenarios passed" over a set that
   includes them without saying how many asserted nothing.
5. **Judge behavior YOURSELF.** Open `<reportDir>/transcript.md` and check each
   `## Behavioral expectations` bullet in the scenario. A failed hard invariant is
   an automatic fail regardless of behavior.
6. **Report.** Summarize pass/fail per scenario. For a hard failure, cite the
   offending JSONL line from `<reportDir>/trace.jsonl`. For a behavioral failure,
   **the skill is the bug, not the agent** — propose the SKILL.md edit, then re-run
   the same scenario to confirm.

## Adding a scenario

Create `skill-eval/scenarios/<skill-or-orchestration>/<NN>-<slug>.md` with
frontmatter (`id`, `title`, `skills`, `mcps`, `agent`, `covers`, optional `runs`,
`timeoutSec`), a `## Prompt`, an optional `## Hard invariants` ```yaml assertions```
block, and optional `## Behavioral expectations` bullets. Then regenerate the
index: `npm run skill:eval:index`. Matchers support `tool`, `endpoint_id` (glob
`*`), `where: "input.x == y"`, and `expect: present|absent` / `count: ">=1"`. A `where`
path may use `*` as a whole segment (not a glob fragment) to fan out over an array — e.g.
`input.platforms.*.accountId == 123` reaches every element of `platforms` and holds when
ANY of them satisfies the predicate, independent of the order the agent listed them in. A
`*` segment on a non-array or an empty array reaches nothing, so the predicate is false
there (use `input.x exists` for presence checks — see `evalWhere` in
`scripts/skill-eval/assertions.ts` for why `!= null` doesn't mean "absent").

These optional frontmatter keys change what the run itself can do:

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
- **`templates: [<repo-relative folder>, …]`** — stage template FOLDERS into
  `<home>/fixtures/templates/<basename>/` and import each one through
  `POST /api/e2e/seed-template` before the prompt, so a scenario about APPLYING a
  template has one to apply (a hermetic home has none). Refer to a seeded id from the
  prompt as `{{template:<basename>}}`. Same repo-relative rule as `fixtures`, and the
  same copy-not-link guarantee. The committed fixtures live under
  `__tests__/helpers/fixtures/templates/`.
- **`hooks: <repo-relative .ts>`** — a module exporting `seed(ctx)` and/or `verify(ctx)`
  (`ScenarioHooks`, `scripts/skill-eval/types.ts`). `seed` runs after the harness's piece
  exists and before the prompt, building state no other key expresses (several pieces in a
  folder, rights stamps) over the studio's HTTP routes and `/api/e2e/run-tool`; what it returns
  as `placeholders` fills `{{seed:<key>}}` in the prompt and replies. `verify` runs after the
  last turn of a completed run and returns OUTCOME checks on the studio's state; they print as
  `state:` lines, land in `state-checks.json` and count toward HARD-PASS. HTTP only — a hooks
  module may not import `@/lib`. Worked example: `_bench/dreams-six-pieces`.
- **`skills: ["*"]`** — every bundled skill enabled, as on a real install (otherwise only the
  listed ones are). Use it where the agent's starting context should match production.
- **`preauthorize: false`** — see the preamble note below. Use it when the
  behaviour under test is that the agent does NOT spend.
- **`catalogCreator: none | pending | approved | rejected`** — the test-mode catalog's
  creator status for every author (`LIBI_TEST_CATALOG_CREATOR`). Publishing is
  invite-only; the default `approved` lets publish scenarios reach the catalog, and the
  others exercise `libi.publish_template`'s invite-only refusal (the fixture traces the
  status read as `creators_me`). Worked example: `templates/08-publish-unapproved.md`.
- **`## Replies`** — a numbered list of scripted user messages, sent one per turn after
  each agent turn completes, whatever the agent asked. This is how a scenario tests "ask,
  wait for the answer, then act": in one turn the agent can only stop at the question or
  answer for the user. A scenario with replies gets a SCRIPTED preamble (its questions
  will be answered; end the turn on them; never act on a yes not yet given) instead of
  "no human is available". Worked example: `templates/04-publish-template.md`.
- **`approve: [<libi tool>, …]`** — libi tools (e.g. an extension's tool marked "requires
  approval") whose approval card the harness answers `allow_once` over the product's own permission route, as a
  user's click would; in such a scenario a card for anything else is answered no, so a
  gated tool it did not declare cannot stall the run. A scenario with NO `approve:` gets no
  answers at all: a card there (only on a host without bypass, i.e. root) is left
  unanswered and the run times out visibly, rather than silently going down a "user said
  no" path nobody declared.
  Declaring any also runs the scenario under libi's `auto` mode instead of
  `auto-with-generations`: under the SDK's bypass libi is never asked, except on a host
  where bypass is unavailable (root), so only `auto` raises the card on every host. Each
  answered card renders into the transcript as
  `[harness-approval <approved|rejected> <tool> reason=<public|extension|acp> offered=<kinds>]`.

`transcript_contains` matches a substring of the rendered transcript rather than the
fal/ElevenLabs trace — the only mechanical way to assert on a `libi.*` call, which never
reaches `fal-calls.jsonl`. A tool call renders as `[tool-call mcp__libi__libi_foo] {args}`,
so match that literal. It cannot be combined with a trace selector, and it is a blunt instrument:
prefer an `endpoint_id` assertion whenever the behaviour you care about is a generation.

`transcript_matches` takes a JavaScript regex (source only, no flags) and counts its matches
in the transcript. Reach for it only when a substring cannot carry the claim: ORDER (the
file was edited after the diagnostic was read) or IDENTITY (the time passed back is the one
the result reported — a backreference). A tool RESULT renders as
`[tool-result  ok] [{"type":"text","text":"<JSON>"}]`, so its quotes are escaped (`\"key\":`)
and a needle written that way cannot be satisfied by the prompt or the agent's prose. It CAN
be satisfied by anything else rendered at the same depth: string values in a tool call's
ARGS (a Bash `command`, a Write `content`, an `add_overlay` `body`) and any non-libi tool
result (a `cat` or Read of a file). A body that carries `"renderDiagnostics":[]` in a comment,
read back by the agent, would forge an escaped needle — so anchor on structure the body cannot
reach, such as the call that produced the result. Edit/Write calls sometimes render with EMPTY
args (`[tool-call Preparing file…] {}`); their result, `"The file <path> has been updated
successfully…"`, still names the file. A pattern that can match the empty string, or does
not compile, is refused when the scenario is parsed — before any run. Pin every regex with a unit test that
runs the scenario's real matchers over a passing transcript and the failing ones it exists to
catch — `__tests__/unit/skill-eval/scenario-code-overlays.test.ts` is the worked example.

Two keys narrow a `transcript_contains` (or a `transcript_matches`, the same way).
**`turn: N`** matches only the agent's answer to the Nth user message (1 = the prompt, 2 = the first reply, …), including the cards answered
in it — the ORDER check: "asked in turn 1, `publish_template` absent from turns 1–2 and
present in turn 3". `turn: [from, to]` matches a range of turns as one text, for "said X
at some point before the yes". **`scope: agent_text`** matches only the agent's own text parts — not
thinking, tool calls, tool results or the user's messages — for "the agent SAID X" where X
also sits in a prompt, a reply or a tool result.

**`ordered: { before: [<needle>, …], then: <needle> }`** (with `expect: present`) asserts ORDER
without pinning turns: every `before` needle (a `transcript_contains`, optionally `scope`d)
must first match in a turn STRICTLY EARLIER than the turn `then` first matches in. Worked
example: `templates/05` — the disclosure ("anyone" + a private/public question) must come in
an earlier turn than the first `publish_template`, so a publish in the same turn as the
disclosure fails and one on the user's next reply passes.

**`{{author-terms:<source>}}`** as an entry of a `transcript_contains` list expands, at parse
time, to needles DERIVED from a fixture's author values: each value verbatim plus every
content word's stem in lower, Capitalised and UPPER case (`scripts/skill-eval/author-terms.ts`).
Use it with `scope: agent_text, expect: absent` for "never quoted OR paraphrased the author"
— a hand list drifts from the fixture and misses inflections ("glowing", "sparkly"). The
fixture's own name and tags must share no word with those values, or quoting the name
trips it (a test enforces this for `left-out-fixture`).

## How a run drives the agent (so your matchers are robust)

- **Runs are unattended** (unless the scenario scripts `## Replies`). The harness sets the
  agent's approval mode to `auto-with-generations` (`auto` when it declares `approve:`)
  and, by default, appends a pre-authorization preamble to
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
- **The host's own Claude config is kept out.** The inner agent runs on the host's Claude
  Code CLI, whose adapter loads the `user` setting source by default — the host's
  `~/.claude/CLAUDE.md`, user settings (hooks, plugins) and `~/.claude/skills` — which once
  made `templates/04`/`05` pass on the host's own "publish only on weekends" rule. The harness
  sets `LIBI_AGENT_SKIP_USER_SETTINGS=1`, and in test mode libi then opens the session with
  `settingSources: ["project", "local"]` (`lib/sessions/session-meta.ts`); the workspace's own
  `.claude/skills` still load. Auth is not a setting source, so no credential is read, copied
  or moved. `_meta/host-config-isolation.md` is the canary (~8 s, ~$0.12) — meaningful only on
  a host that has a `~/.claude/CLAUDE.md`. MCP servers the host added at user scope in
  `~/.claude.json` are not loaded either — verified on Claude Code 2.1.282 (`claude -p
  --setting-sources project,local` mounts none of them) — and in that mode libi's provider
  detection and the test-mode fakes' aliases skip the user scope too
  (`lib/sessions/skip-user-settings.ts`), so `suggest_provider` sees what the session sees.
- **Cost + time.** Each run boots a hermetic server (~18s) and drives a REAL
  inner-agent turn — image-only scenarios ~1.5 min, full UGC (image+video+assemble)
  ~3–5 min — spending real inner-agent (Claude Code) tokens. fal generation itself
  is free (test-mode placeholders). Run only the scenarios a change warrants.

## What it does NOT cover

Real AI quality (placeholders prove the pipeline, not model output), production
performance, cost/rate-limit behavior, and approval-pausing (auto-approved — see
above; a scenario can script the user's answers with `## Replies`, and a declared
`approve:` card is raised and answered, but nothing tests a card left for a human).

## Running on Codex

`--agent codex` (or `agent: codex` in the frontmatter) runs the scenario through libi's in-app
Codex session, the path a user's in-app Codex chat takes. It needs Codex signed in on this
machine: test mode's own Codex home has no sign-in, so the harness points the run at the user's
`CODEX_HOME` (default `~/.codex`) and only READS it (the run's rollouts are copied into the
report's `agent-jsonl/codex/`). Seed/verify hooks, scripted replies and assertions are unchanged.
The user's own Codex config still loads, so a Codex run sees the machine's `~/.agents/skills`,
`~/.codex/AGENTS.md` and `config.toml` servers beside the run's: compare Codex runs only with
other Codex runs on the same machine, and the speed benchmark's metrics with `bench-metrics.ts`
(`docs-local/research/2026-10-03-speed-benchmark.md`).
