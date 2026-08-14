/**
 * Skill-eval CLI. Runs ONE scenario against the inner libi agent in a
 * hermetic test-mode server and prints a verdict.
 *
 *   tsx scripts/skill-eval/run.ts <scenario.md> [--agent claude-code] [--keep]
 *
 * Exit codes: 0 = all runs hard-pass; 2 = a hard invariant failed or a run
 * errored/timed out; 1 = usage / parse error.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseScenario } from "./scenario";
import { evaluate } from "./assertions";
import { runScenarioOnce } from "./harness";
import { writeRunReport, formatStdoutSummary } from "./report";
import type { RunResult } from "./types";

const SUPPORTED_AGENTS = new Set(["claude-code"]);

function parseArgs(argv: string[]): { scenarioPath: string; agentOverride?: string; keep: boolean } {
  const positional: string[] = [];
  let agentOverride: string | undefined;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--agent") agentOverride = argv[++i];
    else if (argv[i] === "--keep") keep = true;
    else positional.push(argv[i]);
  }
  if (positional.length !== 1) {
    throw new Error("usage: tsx scripts/skill-eval/run.ts <scenario.md> [--agent <id>] [--keep]");
  }
  return { scenarioPath: positional[0], agentOverride, keep };
}

/** Deterministic-enough run id from a wall clock passed in by the caller. */
function runStamp(): string {
  // Date is allowed in a plain CLI (not a Workflow script).
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main(): Promise<void> {
  const { scenarioPath, agentOverride, keep } = parseArgs(process.argv.slice(2));
  const abs = resolve(scenarioPath);
  const scenario = parseScenario(readFileSync(abs, "utf8"), abs);

  const agents = agentOverride ? [agentOverride] : scenario.agents;
  const stamp = runStamp();
  const runsRoot = resolve("skill-eval", "runs", stamp);

  const results: RunResult[] = [];
  for (const agent of agents) {
    if (!SUPPORTED_AGENTS.has(agent)) {
      const reportDir = join(runsRoot, scenario.id, agent, "run-1");
      const result: RunResult = {
        scenarioId: scenario.id, agent, status: "unsupported_agent",
        assertions: [], hardPass: false, reportDir,
        errorMessage: `Agent "${agent}" is not supported yet (claude-code only). Abstraction is in place; wire it later.`,
      };
      writeRunReport(reportDir, { result, trace: [], transcript: "" });
      console.log(formatStdoutSummary(result));
      results.push(result);
      continue;
    }

    for (let rep = 1; rep <= scenario.runs; rep++) {
      const reportDir = join(runsRoot, scenario.id, agent, `run-${rep}`);
      const harness = await runScenarioOnce({ scenario, agent, keep });
      const assertions = harness.status === "completed" ? evaluate(harness.trace, scenario.assertions) : [];
      const hardPass = harness.status === "completed" && assertions.every((a) => a.pass);
      const result: RunResult = {
        scenarioId: scenario.id, agent, status: harness.status,
        assertions, hardPass, reportDir, errorMessage: harness.errorMessage,
      };
      writeRunReport(reportDir, { result, trace: harness.trace, transcript: harness.transcript });
      console.log(formatStdoutSummary(result));
      results.push(result);
    }
  }

  // Print a machine-readable summary block for the orchestrating coding agent.
  console.log("\n[skill-eval] JSON_SUMMARY " + JSON.stringify(results.map((r) => ({
    scenarioId: r.scenarioId, agent: r.agent, status: r.status, hardPass: r.hardPass, reportDir: r.reportDir,
  }))));

  const ok = results.every((r) => r.status === "completed" && r.hardPass);
  process.exit(ok ? 0 : 2);
}

main().catch((err) => {
  console.error(`[skill-eval] ${err.message}`);
  process.exit(1);
});
