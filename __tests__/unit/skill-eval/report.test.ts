import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRunReport, formatStdoutSummary } from "@/scripts/skill-eval/report";
import { cliVersionFromStatus } from "@/scripts/skill-eval/harness";
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
  vacuous: false,
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

  /**
   * A scenario with no `## Hard invariants` needles passes on `every([]) === true`. 35 of
   * the suite's 69 are in that state, and while they printed HARD-PASS, half the suite's
   * green was claiming evidence it did not have (`guiding-manual-edits/01` reported
   * HARD-PASS while exercising none of its four `covers:` entries). It gets its own word.
   */
  it("gives an assertion-free run its own verdict, not HARD-PASS", () => {
    const out = formatStdoutSummary({
      ...RESULT, hardPass: true, vacuous: true, assertions: [],
    });
    expect(out).toMatch(/NO-ASSERTIONS/);
    expect(out).not.toMatch(/HARD-PASS/);
    expect(out).toMatch(/declares NO hard invariants/);
  });

  it("still says HARD-PASS when real needles passed", () => {
    const out = formatStdoutSummary({
      ...RESULT,
      hardPass: true,
      vacuous: false,
      assertions: [{ matcher: { tool: "run_model", expect: "present" }, pass: true, matchedCount: 1 }],
    });
    expect(out).toMatch(/HARD-PASS/);
    expect(out).not.toMatch(/NO-ASSERTIONS/);
    expect(out).not.toMatch(/declares NO hard invariants/);
  });

  /** The CLI the in-app agent ran on rides on the verdict line and lands in result.json. */
  it("stamps the claude CLI version on the verdict line and in result.json", () => {
    const stamped: RunResult = {
      ...RESULT, hardPass: true, cliVersion: "2.1.245",
      assertions: [{ matcher: { tool: "run_model", expect: "present" }, pass: true, matchedCount: 1 }],
    };
    expect(formatStdoutSummary(stamped).split("\n")[0]).toMatch(/HARD-PASS · claude 2\.1\.245$/);
    dir = mkdtempSync(join(tmpdir(), "skilleval-"));
    writeRunReport(dir, { result: stamped, trace: [], transcript: "" });
    expect(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).cliVersion).toBe("2.1.245");
  });

  it("marks a report written without a CLI version rather than printing undefined", () => {
    expect(formatStdoutSummary(RESULT).split("\n")[0]).toMatch(/ · claude \?$/);
  });

  /** A timeout is not a vacuous pass — the status word must still win. */
  it("reports the status word for a run that did not complete", () => {
    const out = formatStdoutSummary({
      ...RESULT, status: "timeout", hardPass: false, vacuous: false, assertions: [],
    });
    expect(out).toMatch(/TIMEOUT/);
    expect(out).not.toMatch(/NO-ASSERTIONS/);
  });
});

describe("cliVersionFromStatus", () => {
  it("reads the resolved claude-code CLI version from the status body", () => {
    const body = { agents: { "claude-code": { cli: { path: "/x/claude", realPath: "/x/claude", version: "2.1.245", meetsMinimum: true } } } };
    expect(cliVersionFromStatus(body)).toBe("2.1.245");
  });

  it("reads unresolved for no CLI, a found-but-broken CLI, an error body, or no answer", () => {
    expect(cliVersionFromStatus({ agents: { "claude-code": { cli: null } } })).toBe("unresolved");
    expect(cliVersionFromStatus({ agents: { "claude-code": { cli: { foundButBroken: true, path: "/x/claude" } } } })).toBe("unresolved");
    expect(cliVersionFromStatus({ error: "unknown agent" })).toBe("unresolved");
    expect(cliVersionFromStatus(null)).toBe("unresolved");
  });
});
