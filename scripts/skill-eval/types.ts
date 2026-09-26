import type { Shareable } from "./shared-deps";

/** A single deterministic trace matcher from a scenario's `yaml assertions` block. */
export interface Matcher {
  /** Exact fake-fal tool name, e.g. "run_model" | "submit_job" | "recommend_model". */
  tool?: string;
  /** Exact or glob (`*`) match on the call's endpoint_id. */
  endpoint_id?: string;
  /**
   * Single predicate "input.<dotpath> <op> <literal>", op ∈ == != > >= < <=,
   * or the unary "input.<dotpath> exists".
   *
   * Use `exists` for "this field was sent at all": there is no literal meaning
   * absent, so `!= null` compares against the STRING "null" and matches every
   * call in the trace (see `assertions.ts#evalWhere`).
   */
  where?: string;
  /** Presence assertion. Exactly one of `expect` | `count` must be set. */
  expect?: "present" | "absent";
  /** Count assertion, e.g. ">=1" | "==2" | "<3". */
  count?: string;
  /** Match calls by their unknown-endpoint flag. Combine with expect/count. */
  unknown_endpoint?: boolean;
  /** Filter by recording provider. "fal" | "elevenlabs" | "zernio" | "templates-catalog" (the studio's test-mode catalog fixture). */
  provider?: "fal" | "elevenlabs" | "zernio" | "templates-catalog";
  /** Exact or glob (`*`) match on an ElevenLabs call's voice_id. */
  voice_id?: string;
  /** Exact or glob (`*`) match on an ElevenLabs call's model_id. */
  model_id?: string;
  /**
   * Substring match against the rendered transcript instead of the fal/EL
   * trace — the only way to assert on a `libi.*` tool call, which never lands
   * in fal-calls.jsonl. A tool call renders as `[tool-call libi.foo] {args}`
   * (harness.ts#renderPart), so match that literal. Mutually exclusive with
   * every trace selector (tool / endpoint_id / where / provider / voice_id /
   * model_id / unknown_endpoint).
   */
  /**
   * Substring of the rendered transcript. An array means ANY-OF: the assertion counts
   * occurrences of every alternative and sums them, so `present` passes when the agent
   * took any acceptable route and `absent` requires that it took none of them. Use it
   * where two different tool names satisfy the same behavioural claim.
   */
  transcript_contains?: string | string[];
  /**
   * A JavaScript regular expression (source only, no slashes, no flags) matched against
   * the rendered transcript; the count is the number of non-overlapping matches. Use it
   * where a substring cannot carry the claim: ORDER (the file edit came after the
   * diagnostic was read) and IDENTITY (the time passed back is the time the diagnostic
   * reported — a backreference). Same exclusivity as `transcript_contains`: no trace
   * selectors, and not both. A pattern that matches the empty string is refused, since
   * it would count a match on any transcript at all. `turn` and `scope` narrow it exactly as
   * they narrow a `transcript_contains`.
   */
  transcript_matches?: string;
  /**
   * Narrow a `transcript_contains` to ONE turn: the agent's answer to the Nth user message
   * (1 = the prompt, 2 = the first scripted reply, …) — everything the agent said, called and
   * got back between that user message and the next, plus the harness's answers to any
   * approval card raised in it. This is how a scenario asserts ORDER: "asked in turn 1, and
   * did not call publish_template until turn 3" is two turn-scoped needles. Only valid with
   * `transcript_contains` or `transcript_matches`.
   *
   * `[from, to]` (inclusive) narrows to a RANGE of turns, matched as one text — for "said X
   * at some point before the yes", where saying it in turn 1 or turn 2 are both correct.
   */
  turn?: number | [number, number];
  /**
   * `agent_text`: match only the agent's own words — its text parts, not its thinking, tool
   * calls, tool results, or the user's messages. Use it for "the agent SAID X", where X also
   * appears in a prompt, a scripted reply or a tool result (a template's scaffold, say) and a
   * whole-transcript needle would match that instead. Default `all`. Only valid with
   * `transcript_contains` or `transcript_matches`.
   */
  scope?: "all" | "agent_text";
  /**
   * ORDER across turns: every `before` needle must first match in a turn STRICTLY EARLIER
   * than the turn `then` first matches in — and `then` must match somewhere. Each needle is
   * a `transcript_contains` (ANY-OF when a list) with an optional `scope`. For "the
   * disclosure came before the publish, in an earlier turn — whichever turns those were"
   * (templates/05), where fixed `turn:` needles would pin one conversation shape. Only with
   * `expect: present`, and with no other selector on the same matcher.
   */
  ordered?: { before: OrderedNeedle[]; then: OrderedNeedle };
}

/** One needle inside an `ordered` matcher. */
export interface OrderedNeedle {
  transcript_contains: string | string[];
  scope?: "all" | "agent_text";
}

/**
 * The rendered transcript, whole and per turn — what `transcript_contains` and
 * `transcript_matches` match against.
 * `turns[0]` is the agent's answer to the prompt, `turns[1]` to the first scripted reply, …
 */
export interface TranscriptView {
  full: string;
  /** The agent's own text parts across the whole run (see `Matcher.scope`). */
  agentText: string;
  turns: Array<{ all: string; agentText: string }>;
}

/** A parsed scenario .md file. */
export interface ParsedScenario {
  id: string;
  title: string;
  skills: string[];
  /**
   * MCPs the scenario expects in front of the agent. "fal-ai"/"elevenlabs" mean
   * the test-mode fakes (ACP-injected, lib/mcp-config.ts#getMcpServersForAcp);
   * anything else must be a libi extension id or name. An EMPTY list means "no
   * provider at all" — /api/skill-eval/configure detaches the fakes for it.
   */
  mcps: string[];
  /** Normalized to a non-empty array (frontmatter may be a string or array). */
  agents: string[];
  runs: number;
  timeoutSec: number;
  /** Opt-in: run fake-fal in strict mode (unknown endpoint_id → 404). Default false. */
  falStrict: boolean;
  /**
   * libi's OWN connection to the social provider for this run — a different
   * thing from the `zernio` fake being in front of the AGENT (that is `mcps`).
   *
   * - `none` (default): no provider is chosen, so `/api/social/status` answers
   *   `providerId: null` and the skill's gate routes to `suggest_provider`.
   *   Every non-social scenario is in this state and always was.
   * - `connected`: the harness selects zernio in libi's settings. Test mode has
   *   already written the grant that makes that read as connected
   *   (`lib/social/test-fake.ts`), so `libi.post_piece` is exercisable.
   * - `disconnected`: provider chosen, NO grant — the state where the agent's
   *   own zernio sign-in works and libi's does not. The harness gets it by
   *   setting `LIBI_SOCIAL_TEST_NO_GRANT=1`, which suppresses the test-mode
   *   grant write. Clearing `LIBI_SOCIAL_MCP_URL` would NOT do it: unset is
   *   exactly what makes the studio start its own fake and write the grant.
   */
  social: "none" | "connected" | "disconnected";
  /**
   * Opt-in: subtrees of the real `~/.libi` to COPY into this scenario's temp
   * home before boot — `bin` (uv, ffmpeg, yt-dlp) and/or `models` (weights).
   * Only those two names are accepted, and it is a copy, never a symlink, so
   * the run cannot write back into the user's Libi Home
   * (`scripts/skill-eval/shared-deps.ts`). Empty by default: a scenario
   * written against an empty home is asserting the `needs_install` path, and
   * handing it `bin/uv` changes what the agent can do.
   */
  share: Shareable[];
  /**
   * Media staged into the hermetic home before the run. Each entry is a
   * repo-relative path to a real file in the tree; the harness copies it into
   * `<home>/fixtures/<basename>` and the prompt refers to it from there. This is
   * what makes a scenario that needs INPUT media (transcription, captions,
   * anything reading an existing clip) runnable at all — the harness creates an
   * empty piece and seeds nothing, so before this those scenarios could only
   * carry `assertions: []`. Repo-relative and inside the repo, enforced at parse
   * time: it is a fixture mechanism, not "point the harness at any file".
   */
  fixtures: string[];
  /**
   * Repo-relative template FOLDERS seeded into the spawned libi before the prompt
   * (staged to `<home>/fixtures/templates/<basename>`, then
   * `POST /api/e2e/seed-template`). The prompt may reference a seeded id as
   * `{{template:<basename>}}`.
   *
   * Same reasoning as `fixtures`: the harness creates an empty libi with no
   * templates in it, so a scenario about APPLYING a template could otherwise only
   * assert on a template the agent wrote itself — which tests the create flow, not
   * the apply one. Repo-relative and inside the repo, enforced at parse time.
   */
  templates: string[];
  /**
   * Canvas size seeded onto the harness's freshly-created piece, via
   * `PATCH /api/pieces/:id/composition/dimensions`, BEFORE the prompt is sent. `POST
   * /api/pieces` always creates 1920×1080 — a scenario that needs a different aspect
   * (a 9:16 export gate, for instance) sets this instead of relying on the agent to
   * resize the canvas itself, which is a different skill's behaviour and not what
   * such a scenario is testing. `undefined` (the default) leaves the piece at
   * 1920×1080.
   */
  pieceDimensions?: readonly [width: number, height: number];
  /**
   * Whether to append the pre-authorization preamble. Default TRUE — an
   * unattended run that stops at "OK to generate?" produces an empty trace and a
   * false FAIL. `preauthorize: false` swaps in a preamble that forbids spending
   * and requires the agent to ASK, which is the only way a scenario can assert a
   * paid call is ABSENT: with the default preamble in front of it, "prefer the
   * free path" is structurally unassertable (an agent has reasoned correctly and
   * then spent anyway, citing the pre-authorization).
   */
  preauthorize: boolean;
  /**
   * The test-mode catalog's creator status for every author (`LIBI_TEST_CATALOG_CREATOR`,
   * lib/templates/cloud/test-fixture.ts). Publishing is invite-only: `undefined` (the
   * default) boots it `approved`, so publish scenarios reach the catalog; `none` /
   * `pending` / `rejected` exercise the invite-only refusal.
   */
  catalogCreator?: "none" | "pending" | "approved" | "rejected";
  /**
   * Scripted follow-up user messages, sent one per turn after each agent turn completes,
   * whatever the agent asked. Empty (the default) is the one-turn run every older scenario
   * is. A scenario whose behaviour is "ask, wait for the answer, then act" needs them: in one
   * turn the agent either stops at the question (and the act is never reached) or answers
   * for the user (the failure). Written in the `## Replies` section as a numbered list.
   */
  replies: string[];
  /**
   * libi tools (without the `libi.` prefix, e.g. `publish_template`) whose approval card the
   * harness answers YES to. Declaring any also runs the scenario in libi's `auto` approval
   * mode instead of `auto-with-generations`, so libi's own permission handler is asked on
   * every host (under the SDK's bypass it never is, except where bypass is unavailable, as for
   * root) and the card is raised — and answered — identically everywhere. A card for a tool
   * NOT listed is answered no, so a run never stalls on one. The answer comes from the
   * harness over the product's own permission route, exactly as a user's click would; the
   * product's gate is not touched.
   */
  approve: string[];
  covers: string[];
  /** The verbatim "## Prompt" body, trimmed. */
  prompt: string;
  /** Matchers from the "## Hard invariants" yaml block (empty if none). */
  assertions: Matcher[];
  /** Prose bullets from "## Behavioral expectations" (empty if none). */
  behavior: string[];
  /** Source path, for error messages + reports. */
  sourcePath: string;
}

/** One recorded fake call (structural subset of the three `recorder.ts` files under `mcp/dev/`, plus the templates catalog fixture's trace). */
export interface TraceCall {
  tool: string;
  endpoint_id?: string;
  canonical_endpoint_id?: string;
  unknown_endpoint?: boolean;
  input?: unknown;
  request_id?: string;
  ts?: string;
  /** Assigned by the harness on read: which recorder produced this line. */
  provider?: "fal" | "elevenlabs" | "zernio" | "templates-catalog";
  // --- ElevenLabs call fields (present only when provider==="elevenlabs") ---
  voice_id?: string;
  voice_name?: string;
  model_id?: string;
  input_file_path?: string;
  output_path?: string;
  text?: string;
  prompt?: string;
  name?: string;
  // --- Zernio call fields (present only when provider==="zernio") ----------
  /** How the tool was dispatched: directly, or through Zernio's `call_tool`. */
  via?: "direct" | "call_tool";
  post_id?: string;
  /** `true` when the fake REFUSED the call (unknown tool, or bad arguments). */
  rejected?: boolean;
  // --- Templates catalog fixture fields (present only when provider==="templates-catalog") ---
  /** The HTTP status the fixture answered. */
  status?: number;
  /** The site's refusal code, when it refused (`PUBLISH_ERROR_CODES`). */
  code?: string;
}

/** Result of evaluating one matcher against a trace. */
export interface AssertionResult {
  matcher: Matcher;
  pass: boolean;
  matchedCount: number;
  /** Calls that violated the assertion (for `absent`, the offending matches). */
  offendingCalls?: TraceCall[];
  /** Human-readable failure reason; undefined when pass. */
  reason?: string;
}

/** Aggregate result of one scenario run (one agent, one repetition). */
export interface RunResult {
  scenarioId: string;
  agent: string;
  /** "completed" | "errored" | "timeout" | "unsupported_agent". */
  status: "completed" | "errored" | "timeout" | "unsupported_agent";
  assertions: AssertionResult[];
  /** True when status==="completed" AND every assertion passed. */
  hardPass: boolean;
  /**
   * True when the run completed but the scenario declared NO hard invariants, so
   * `hardPass` is the mechanical `every([]) === true` and proves only "did not crash".
   * 35 of 69 scenarios are in this state (QA, 2026-09-10), and while they reported the
   * same HARD-PASS as a scenario with real needles, half the suite's green read as
   * evidence it was not. `guiding-manual-edits/01` is the worked example: it passes
   * while exercising none of its four `covers:` entries, because the caption its prompt
   * assumes is never seeded. Reported as its own verdict rather than folded into
   * HARD-PASS; the exit code is deliberately unchanged, since an assertion-free scenario
   * is under-specified, not failing.
   */
  vacuous: boolean;
  /**
   * The `claude --version` the in-app agent ran on — read from the hermetic libi's
   * `/api/agents/status`, since evals now run on the user's own CLI. `"unresolved"` when
   * that libi found no usable CLI or never answered; absent only on reports written before
   * the field existed.
   */
  cliVersion?: string;
  errorMessage?: string;
  /** Absolute path to the written run-report directory. */
  reportDir: string;
  /** Wall-clock seconds from the first prompt to the last turn's completion. */
  durationSec?: number;
  /** The agent's cumulative session cost, when its adapter reported one (ACP usage_update). */
  cost?: { amount: number; currency: string } | null;
}
