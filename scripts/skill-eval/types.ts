import type { Shareable } from "./shared-deps";

/** A single deterministic trace matcher from a scenario's `yaml assertions` block. */
export interface Matcher {
  /** Exact fake-fal tool name, e.g. "run_model" | "submit_job" | "recommend_model". */
  tool?: string;
  /** Exact or glob (`*`) match on the call's endpoint_id. */
  endpoint_id?: string;
  /** Single predicate "input.<dotpath> <op> <literal>", op ∈ == != > >= < <=. */
  where?: string;
  /** Presence assertion. Exactly one of `expect` | `count` must be set. */
  expect?: "present" | "absent";
  /** Count assertion, e.g. ">=1" | "==2" | "<3". */
  count?: string;
  /** Match calls by their unknown-endpoint flag. Combine with expect/count. */
  unknown_endpoint?: boolean;
  /** Filter by recording provider. "fal" (default for fal-calls) | "elevenlabs". */
  provider?: "fal" | "elevenlabs";
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
}

/** A parsed scenario .md file. */
export interface ParsedScenario {
  id: string;
  title: string;
  skills: string[];
  /**
   * MCPs the scenario expects in front of the agent. "fal-ai"/"ElevenLabs" mean
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
   * Whether to append the pre-authorization preamble. Default TRUE — an
   * unattended run that stops at "OK to generate?" produces an empty trace and a
   * false FAIL. `preauthorize: false` swaps in a preamble that forbids spending
   * and requires the agent to ASK, which is the only way a scenario can assert a
   * paid call is ABSENT: with the default preamble in front of it, "prefer the
   * free path" is structurally unassertable (an agent has reasoned correctly and
   * then spent anyway, citing the pre-authorization).
   */
  preauthorize: boolean;
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

/** One recorded fake-fal call (structural subset of mcp/dev/fake-fal/recorder.ts#FakeFalCall). */
export interface TraceCall {
  tool: string;
  endpoint_id?: string;
  canonical_endpoint_id?: string;
  unknown_endpoint?: boolean;
  input?: unknown;
  request_id?: string;
  ts?: string;
  /** Assigned by the harness on read: which recorder produced this line. */
  provider?: "fal" | "elevenlabs";
  // --- ElevenLabs call fields (present only when provider==="elevenlabs") ---
  voice_id?: string;
  voice_name?: string;
  model_id?: string;
  input_file_path?: string;
  output_path?: string;
  text?: string;
  prompt?: string;
  name?: string;
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
}
