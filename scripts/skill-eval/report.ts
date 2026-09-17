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
  // The CLI version rides on the verdict line: a pass on one `claude` release is not a pass
  // on the next, so a summary that omits it cannot be compared across runs.
  lines.push(`[skill-eval] ${result.scenarioId} (${result.agent}): ${verdictFor(result)} · claude ${result.cliVersion ?? "?"}`);
  if (result.vacuous && result.status === "completed") {
    lines.push(
      "  WARNING: this scenario declares NO hard invariants, so nothing was mechanically " +
        "checked. It completed — that is all this verdict means. Judge it from " +
        "transcript.md, or give it needles.",
    );
  }
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
