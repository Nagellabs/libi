import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRunReport, formatStdoutSummary } from "@/scripts/skill-eval/report";
import type { RunResult } from "@/scripts/skill-eval/types";

let dir = "";
afterEach(() => {
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

const RESULT: RunResult = {
  scenarioId: "demo",
  agent: "claude-code",
  status: "completed",
  hardPass: false,
  reportDir: "",
  assertions: [
    { matcher: { tool: "run_model", expect: "present" }, pass: true, matchedCount: 1 },
    { matcher: { endpoint_id: "fal-ai/nano-banana*", expect: "absent" }, pass: false, matchedCount: 1, reason: "expected 0, found 1" },
  ],
};

describe("report", () => {
  it("writes trace, transcript, invariants, and result files", () => {
    dir = mkdtempSync(join(tmpdir(), "skilleval-"));
    writeRunReport(dir, {
      result: RESULT,
      trace: [{ tool: "run_model", endpoint_id: "openai/gpt-image-2" }],
      transcript: "agent said hi",
    });
    expect(existsSync(join(dir, "trace.jsonl"))).toBe(true);
    expect(readFileSync(join(dir, "transcript.md"), "utf8")).toContain("agent said hi");
    expect(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).scenarioId).toBe("demo");
    expect(JSON.parse(readFileSync(join(dir, "invariants.json"), "utf8"))).toHaveLength(2);
  });

  it("summary marks FAIL and cites the failing matcher", () => {
    const out = formatStdoutSummary(RESULT);
    expect(out).toMatch(/FAIL/);
    expect(out).toMatch(/nano-banana/);
  });
});
