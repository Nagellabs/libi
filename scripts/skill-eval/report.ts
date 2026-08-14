import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult, TraceCall } from "./types";

export interface ReportPayload {
  result: RunResult;
  trace: TraceCall[];
  transcript: string;
}

/** Write the four artifacts for one run into `dir` (created if needed). */
export function writeRunReport(dir: string, payload: ReportPayload): void {
  mkdirSync(dir, { recursive: true });
  const traceLines = payload.trace.map((c) => JSON.stringify(c)).join("\n");
  writeFileSync(join(dir, "trace.jsonl"), traceLines + (traceLines ? "\n" : ""));
  writeFileSync(join(dir, "transcript.md"), payload.transcript);
  writeFileSync(join(dir, "invariants.json"), JSON.stringify(payload.result.assertions, null, 2));
  writeFileSync(join(dir, "result.json"), JSON.stringify(payload.result, null, 2));
}

/** Compact human summary printed to stdout for the orchestrating coding agent. */
export function formatStdoutSummary(result: RunResult): string {
  const lines: string[] = [];
  const verdict = result.status !== "completed" ? result.status.toUpperCase() : result.hardPass ? "HARD-PASS" : "FAIL";
  lines.push(`[skill-eval] ${result.scenarioId} (${result.agent}): ${verdict}`);
  if (result.errorMessage) lines.push(`  error: ${result.errorMessage}`);
  for (const a of result.assertions) {
    const mark = a.pass ? "✓" : "✗";
    const sel = a.matcher.endpoint_id ?? a.matcher.tool ?? a.matcher.where ?? "(any)";
    const rule = a.matcher.expect ?? a.matcher.count ?? "?";
    lines.push(`  ${mark} ${sel} [${rule}] matched=${a.matchedCount}${a.reason ? ` — ${a.reason}` : ""}`);
  }
  lines.push(`  report: ${result.reportDir}`);
  lines.push(`  NOTE: hard invariants are mechanical; YOU must still judge the behavioral expectations from transcript.md.`);
  return lines.join("\n");
}
