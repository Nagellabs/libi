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
}

/** A parsed scenario .md file. */
export interface ParsedScenario {
  id: string;
  title: string;
  skills: string[];
  mcps: string[];
  /** Normalized to a non-empty array (frontmatter may be a string or array). */
  agents: string[];
  runs: number;
  timeoutSec: number;
  /** Opt-in: run fake-fal in strict mode (unknown endpoint_id → 404). Default false. */
  falStrict: boolean;
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
  errorMessage?: string;
  /** Absolute path to the written run-report directory. */
  reportDir: string;
}
