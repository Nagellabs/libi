import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunResult, TraceCall } from "./types";
import { describeTurn } from "./assertions";
import { metricsFromClaudeLogs, metricsFromCodexRollouts, type AcpToolCall } from "./bench-metrics";

export interface ReportPayload {
  result: RunResult;
  trace: TraceCall[];
  transcript: string;
  /** The inner agent's session logs, copied into `agent-jsonl/` (see harness.ts#readAgentLogs). */
  agentLogs?: Array<{ path: string; content: string }>;
  /** The chat's tool calls in order (`acp-tool-calls.json`) — the exact record of a Codex run's nested calls. */
  toolCalls?: AcpToolCall[];
}

/**
 * Write one run's artifacts into `dir` (created if needed): trace, transcript, invariants and
 * result — plus, when the agent's session logs were found, those logs under `agent-jsonl/` and
 * the speed metrics read from them (`metrics.json`, also summarised on `result.metrics`), and
 * the `verify` hook's checks (`state-checks.json`).
 */
export function writeRunReport(dir: string, payload: ReportPayload): void {
  mkdirSync(dir, { recursive: true });
  if (payload.agentLogs?.length) {
    for (const log of payload.agentLogs) {
      const dest = join(dir, "agent-jsonl", log.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, log.content);
    }
    const contents = payload.agentLogs.map((l) => l.content);
    const m =
      payload.result.agent === "codex"
        ? metricsFromCodexRollouts(contents, payload.result.turnWindows, payload.toolCalls)
        : metricsFromClaudeLogs(contents, payload.result.turnWindows);
    writeFileSync(join(dir, "metrics.json"), JSON.stringify(m, null, 2));
    payload.result.metrics = {
      apiTurns: m.apiTurns, toolCalls: m.toolCalls, input: m.input, cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite, output: m.output, wallSec: m.wallSec,
      ...(m.codex
        ? { codex: { execCalls: m.codex.execCalls, libiCalls: m.codex.libiCalls, nestedSource: m.codex.nestedSource, reasoning: m.codex.reasoning } }
        : {}),
    };
  }
  if (payload.toolCalls?.length) {
    writeFileSync(join(dir, "acp-tool-calls.json"), JSON.stringify(payload.toolCalls, null, 1));
  }
  if (payload.result.stateChecks) {
    writeFileSync(join(dir, "state-checks.json"), JSON.stringify(payload.result.stateChecks, null, 2));
  }
  const traceLines = payload.trace.map((c) => JSON.stringify(c)).join("\n");
  writeFileSync(join(dir, "trace.jsonl"), traceLines + (traceLines ? "\n" : ""));
  writeFileSync(join(dir, "transcript.md"), payload.transcript);
  writeFileSync(join(dir, "invariants.json"), JSON.stringify(payload.result.assertions, null, 2));
  writeFileSync(join(dir, "result.json"), JSON.stringify(payload.result, null, 2));
}

/**
 * The verdict word for one run.
 *
 * `NO-ASSERTIONS` is its own verdict, not a flavour of HARD-PASS. A scenario that declares
 * no `## Hard invariants` needles passes on `every([]) === true`, which proves only that the
 * run completed — and 35 of the suite's 69 scenarios are in that state, so for half the
 * suite "HARD-PASS" was claiming evidence that did not exist. Separating the word is the
 * whole fix: the exit code still treats it as a pass, because an assertion-free scenario is
 * under-specified rather than broken.
 */
function verdictFor(result: RunResult): string {
  if (result.status !== "completed") return result.status.toUpperCase();
  if (!result.hardPass) return "FAIL";
  return result.vacuous ? "NO-ASSERTIONS" : "HARD-PASS";
}

/** Compact human summary printed to stdout for the orchestrating coding agent. */
export function formatStdoutSummary(result: RunResult): string {
  const lines: string[] = [];
  // The CLI version rides on the verdict line: a pass on one `claude` (or `codex`) release is not a pass
  // on the next, so a summary that omits it cannot be compared across runs.
  lines.push(`[skill-eval] ${result.scenarioId} (${result.agent}): ${verdictFor(result)} · ${result.agent === "codex" ? "codex" : "claude"} ${result.cliVersion ?? "?"}`);
  if (result.vacuous && result.status === "completed") {
    lines.push(
      "  WARNING: this scenario declares NO hard invariants, so nothing was mechanically " +
        "checked. It completed — that is all this verdict means. Judge it from " +
        "transcript.md, or give it needles.",
    );
  }
  if (result.errorMessage) lines.push(`  error: ${result.errorMessage}`);
  if (result.durationSec !== undefined) {
    const cost = result.cost ? ` · ${result.cost.amount.toFixed(4)} ${result.cost.currency}` : " · cost not reported";
    lines.push(`  took ${result.durationSec}s${cost}`);
  }
  if (result.metrics) {
    const m = result.metrics;
    const k = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : `${(x / 1e3).toFixed(1)}K`);
    lines.push(
      `  agent: ${m.apiTurns} API turns · ${m.toolCalls} tool calls · in ${k(m.input)} · cache-read ${k(m.cacheRead)} · cache-write ${k(m.cacheWrite)} · out ${k(m.output)}`,
    );
    if (m.codex) {
      lines.push(
        `  codex: ${m.codex.execCalls} exec scripts · ${m.codex.libiCalls} libi calls (${m.codex.nestedSource === "executed" ? "executed" : "from script text, loops counted once"}) · reasoning ${k(m.codex.reasoning)} of the output`,
      );
    }
  }
  const checks = result.stateChecks ?? [];
  // A long list (one row per piece × check) prints its failures and a count; state-checks.json has all.
  const shown = checks.length > 12 ? checks.filter((c) => !c.pass).slice(0, 24) : checks;
  for (const c of shown) {
    lines.push(`  ${c.pass ? "✓" : "✗"} state: ${c.name}${!c.pass && c.detail ? ` — ${c.detail}` : ""}`);
  }
  if (shown.length < checks.length) {
    lines.push(`  state checks: ${checks.filter((c) => c.pass).length}/${checks.length} passed (all in state-checks.json)`);
  }
  for (const a of result.assertions) {
    const mark = a.pass ? "✓" : "✗";
    const needle = a.matcher.transcript_contains;
    const narrowed = [describeTurn(a.matcher.turn), a.matcher.scope === "agent_text" ? "agent text" : ""].filter(Boolean).join(", ");
    const sel =
      a.matcher.endpoint_id ??
      a.matcher.tool ??
      a.matcher.where ??
      (needle !== undefined
        ? `${JSON.stringify(needle)}${narrowed ? ` (${narrowed})` : ""}`
        : a.matcher.transcript_matches !== undefined
          ? `/${a.matcher.transcript_matches}/${narrowed ? ` (${narrowed})` : ""}`
          : a.matcher.ordered
            ? `ordered: ${a.matcher.ordered.before.map((b) => JSON.stringify(b.transcript_contains)).join(" + ")} before ${JSON.stringify(a.matcher.ordered.then.transcript_contains)}`
            : "(any)");
    const rule = a.matcher.expect ?? a.matcher.count ?? "?";
    lines.push(`  ${mark} ${sel} [${rule}] matched=${a.matchedCount}${a.reason ? ` — ${a.reason}` : ""}`);
  }
  lines.push(`  report: ${result.reportDir}`);
  lines.push(`  NOTE: hard invariants are mechanical; YOU must still judge the behavioral expectations from transcript.md.`);
  return lines.join("\n");
}
