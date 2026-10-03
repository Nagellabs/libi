import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acpToolName,
  codexHomeDir,
  findCodexRollouts,
  isCodexRollout,
  metricsForReportDir,
  metricsFromClaudeLogs,
  metricsFromCodexRollouts,
  nestedCallsInScript,
  type AcpToolCall,
} from "@/scripts/skill-eval/bench-metrics";
import { acpToolCallsFrom, agentEnvFor, cliVersionFromStatus, readRunAgentLogs } from "@/scripts/skill-eval/harness";
import { formatStdoutSummary, writeRunReport } from "@/scripts/skill-eval/report";
import type { RunResult } from "@/scripts/skill-eval/types";

const ROLLOUT = readFileSync("__tests__/fixtures/codex/bench-rollout.jsonl", "utf8");
const FORK = readFileSync("__tests__/fixtures/codex/bench-rollout-fork.jsonl", "utf8");

const tmp: string[] = [];
const mk = () => {
  const d = mkdtempSync(join(tmpdir(), "bench-codex-"));
  tmp.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmp.splice(0)) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

describe("metricsFromCodexRollouts", () => {
  it("counts one API turn per model request: a repeated token_count and a fork's replayed total do not add", () => {
    const m = metricsFromCodexRollouts([ROLLOUT, FORK]);
    expect(m.agent).toBe("codex");
    expect(m.apiTurns).toBe(4);
    expect(m.models).toEqual({ "gpt-6-sol": 4 });
  });

  it("splits Codex's input (which includes the cached part) into uncached input and cache-read", () => {
    const m = metricsFromCodexRollouts([ROLLOUT]);
    expect(m.cacheRead).toBe(0 + 21000 + 23000 + 26000);
    expect(m.input).toBe(21000 + 2000 + 3000 + 1000);
    expect(m.cacheWrite).toBe(0);
    expect(m.output).toBe(80 + 120 + 400 + 60);
    expect(m.codex?.reasoning).toBe(10 + 40 + 100);
    expect(m.codex?.inputIncludingCached).toBe(21000 + 23000 + 26000 + 27000);
    expect(m.codex?.firstRequestInput).toBe(21000);
  });

  it("falls back to token_usage_record lines when a rollout has no token_count info", () => {
    const records = ROLLOUT.split("\n").filter((l) => l.includes('"token_usage_record"') || l.includes('"session_meta"')).join("\n");
    const m = metricsFromCodexRollouts([records]);
    expect(m.apiTurns).toBe(4);
    expect(m.output).toBe(660);
  });

  it("reads tool calls from the exec scripts: libi calls inside exec by name, the exec wrappers and ALL_TOOLS lookups apart", () => {
    const m = metricsFromCodexRollouts([ROLLOUT, FORK]);
    // The fork replays call c2 under the same call_id: counted once.
    expect(m.codex?.execCalls).toBe(3);
    expect(m.codex?.allToolsLookups).toBe(1);
    expect(m.codex?.otherTopLevel).toEqual({ wait: 1 });
    expect(m.codex?.nestedSource).toBe("source");
    // A loop in the script text counts once — the documented lower bound.
    expect(m.toolsByName).toEqual({
      "libi.list_pieces": 1,
      "libi.update_overlay": 1,
      exec_command: 1,
      "libi.get_piece_state": 1,
      wait: 1,
    });
    expect(m.codex?.libiCalls).toBe(3);
    expect(m.toolCalls).toBe(5);
  });

  it("takes the executed calls from the studio's record when given, so a loop over six pieces counts six", () => {
    const acp: AcpToolCall[] = [
      { toolId: "libi:libi.list_pieces", startedAt: Date.parse("2026-10-03T00:00:21.000Z") },
      ...Array.from({ length: 6 }, () => ({ toolId: "libi:libi.update_overlay", startedAt: Date.parse("2026-10-03T00:00:22.000Z") })),
      { toolId: null, title: "ls", startedAt: Date.parse("2026-10-03T00:00:23.000Z") },
      { toolId: "libi:libi.get_piece_state", startedAt: Date.parse("2026-10-03T00:01:06.000Z") },
    ];
    const m = metricsFromCodexRollouts([ROLLOUT], undefined, acp);
    expect(m.codex?.nestedSource).toBe("executed");
    expect(m.toolsByName["libi.update_overlay"]).toBe(6);
    expect(m.codex?.libiCalls).toBe(8);
    expect(m.codex?.libiCallsInSource).toBe(3);
    // 9 nested + the one top-level `wait`.
    expect(m.toolCalls).toBe(10);
    expect(m.toolsByName["builtin:shell"]).toBe(1);
    expect(m.toolsByName.wait).toBe(1);
    expect(m.perTurn.map((t) => t.toolCalls)).toEqual([9, 1]);
  });

  it("buckets turns by the rollout's own task windows, or by the harness's", () => {
    const own = metricsFromCodexRollouts([ROLLOUT]);
    expect(own.perTurn.map((t) => [t.apiTurns, t.wallSec])).toEqual([[3, 40], [1, 20]]);
    expect(own.perTurn[0].output).toBe(600);
    expect(own.wallSec).toBe(70);
    const byWindow = metricsFromCodexRollouts([ROLLOUT], [
      { startedAt: "2026-10-03T00:00:10.000Z", endedAt: "2026-10-03T00:00:55.000Z" },
      { startedAt: "2026-10-03T00:01:00.000Z", endedAt: "2026-10-03T00:01:30.000Z" },
    ]);
    expect(byWindow.perTurn.map((t) => t.wallSec)).toEqual([45, 30]);
    expect(byWindow.wallSec).toBe(80);
  });

  it("an empty rollout set is all zeros, not a crash", () => {
    const m = metricsFromCodexRollouts([]);
    expect(m.apiTurns).toBe(0);
    expect(m.toolCalls).toBe(0);
    expect(m.wallSec).toBeNull();
  });
});

describe("Code Mode scripts", () => {
  it("lists the tools a script calls, in order, however they are spelled", () => {
    const src = `const a = await tools.mcp__libi__libi_list_pieces({});
      const b = await tools["mcp__libi__libi_get_overlays"]({});
      await tools.exec_command({cmd:"ls"}); await tools.mcp__elevenlabs__creative_list_voices({});`;
    expect(nestedCallsInScript(src)).toEqual(["libi.list_pieces", "libi.get_overlays", "exec_command", "elevenlabs:creative_list_voices"]);
    expect(nestedCallsInScript("text(ALL_TOOLS.length)")).toEqual([]);
  });

  it("names an ACP tool call by its tool id, or by what a built-in is", () => {
    expect(acpToolName({ toolId: "libi:libi.add_keyframe" })).toBe("libi.add_keyframe");
    expect(acpToolName({ toolId: "libi-app:libi.show" })).toBe("libi.show");
    expect(acpToolName({ toolId: "fal-ai:run_model" })).toBe("fal-ai:run_model");
    expect(acpToolName({ toolId: null, title: "Read file '/x/SKILL.md'" })).toBe("builtin:read_file");
    expect(acpToolName({ toolId: null, title: "grep -R foo ." })).toBe("builtin:shell");
  });
});

describe("telling the two agents' logs apart", () => {
  it("recognises a rollout by its session_meta line", () => {
    expect(isCodexRollout(ROLLOUT)).toBe(true);
    expect(isCodexRollout(JSON.stringify({ type: "user", message: {} }))).toBe(false);
    expect(isCodexRollout("")).toBe(false);
  });

  it("leaves the Claude reader alone: a Claude log still reads as before", () => {
    const log = JSON.stringify({ type: "assistant", timestamp: "2026-10-03T00:00:02.000Z", message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 2, cache_read_input_tokens: 10, output_tokens: 3 }, content: [{ type: "tool_use", id: "t", name: "Read" }] } });
    const m = metricsFromClaudeLogs([log]);
    expect(m.apiTurns).toBe(1);
    expect(m.agent).toBeUndefined();
    expect(m.codex).toBeUndefined();
  });
});

describe("findCodexRollouts", () => {
  /** A Codex home with sessions for this run, another run and no cwd at all. */
  function codexHome(day: Date) {
    const home = mk();
    const dir = join(home, "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
    mkdirSync(dir, { recursive: true });
    const meta = (cwd: string) => JSON.stringify({ timestamp: day.toISOString(), type: "session_meta", payload: { cwd, base_instructions: { text: "x".repeat(200_000) } } }) + "\n";
    writeFileSync(join(dir, "rollout-a-111.jsonl"), meta("/private/var/folders/x/T/libi-skilleval-RunA/agent") + ROLLOUT.split("\n").slice(1).join("\n"));
    writeFileSync(join(dir, "rollout-b-222.jsonl"), meta("/private/var/folders/x/T/libi-skilleval-RunB/agent"));
    writeFileSync(join(dir, "rollout-c-333.jsonl"), JSON.stringify({ type: "session_meta", payload: {} }) + "\n");
    writeFileSync(join(dir, "notes.txt"), "not a rollout");
    return home;
  }

  it("matches a run's rollouts by the temp home's name in the cwd, however long the first line is", () => {
    const now = new Date();
    const found = findCodexRollouts({ codexHome: codexHome(now), sinceMs: now.getTime() - 60_000, untilMs: now.getTime(), cwdIncludes: "libi-skilleval-RunA" });
    expect(found).toHaveLength(1);
    expect(found[0].path).toMatch(/^codex\/\d{4}\/\d{2}\/\d{2}\/rollout-a-111\.jsonl$/);
    expect(metricsFromCodexRollouts(found.map((f) => f.content)).apiTurns).toBe(4);
  });

  it("looks at the days around the run (a run across midnight), and at nothing for an absent home", () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    const home = codexHome(yesterday);
    const now = Date.now();
    expect(findCodexRollouts({ codexHome: home, sinceMs: now - 1000, untilMs: now, cwdIncludes: "RunA" })).toHaveLength(1);
    expect(findCodexRollouts({ codexHome: join(home, "nope"), sinceMs: now, untilMs: now, cwdIncludes: "RunA" })).toEqual([]);
    const lastWeek = now - 7 * 86_400_000;
    expect(findCodexRollouts({ codexHome: home, sinceMs: lastWeek, untilMs: lastWeek + 1000, cwdIncludes: "RunA" })).toEqual([]);
  });

  it("never writes into the Codex home", () => {
    const now = new Date();
    const home = codexHome(now);
    const before = readFileSync(join(home, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"), "rollout-b-222.jsonl"), "utf8");
    findCodexRollouts({ codexHome: home, sinceMs: now.getTime(), untilMs: now.getTime(), cwdIncludes: "RunB" });
    expect(readFileSync(join(home, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"), "rollout-b-222.jsonl"), "utf8")).toBe(before);
  });
});

// ProcessEnv carries a required NODE_ENV under Next's types; a partial env is what these cases mean.
const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;

describe("the harness's Codex wiring", () => {
  it("points a Codex run at Codex's own home (test mode's scoped one has no sign-in), and leaves Claude alone", () => {
    expect(agentEnvFor("codex", env({ CODEX_HOME: "/custom/codex" }))).toEqual({ CODEX_HOME: "/custom/codex" });
    expect(agentEnvFor("codex", env({}))).toEqual({ CODEX_HOME: codexHomeDir(env({})) });
    expect(codexHomeDir(env({}))).toMatch(/\.codex$/);
    expect(agentEnvFor("claude-code", env({ CODEX_HOME: "/custom/codex" }))).toEqual({});
  });

  it("reads the Codex CLI version from the status body", () => {
    const body = { agents: { codex: { cli: { version: "0.155.0" } }, "claude-code": { cli: { version: "2.1.282" } } } };
    expect(cliVersionFromStatus(body, "codex")).toBe("0.155.0");
    expect(cliVersionFromStatus(body)).toBe("2.1.282");
    expect(cliVersionFromStatus({ agents: { codex: { cli: null } } }, "codex")).toBe("unresolved");
  });

  it("reads a Codex run's logs from the rollouts, not a Claude project dir", () => {
    const now = new Date();
    const home = mk();
    const day = join(home, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-x-1.jsonl"), JSON.stringify({ type: "session_meta", payload: { cwd: "/private/var/x/libi-skilleval-Zz9/agent" } }) + "\n");
    const logs = readRunAgentLogs({ agent: "codex", home: "/var/x/libi-skilleval-Zz9", startedAtMs: now.getTime(), endedAtMs: now.getTime(), env: env({ CODEX_HOME: home }) });
    expect(logs.map((l) => l.path.split("/").pop())).toEqual(["rollout-x-1.jsonl"]);
  });

  it("records every tool call in the chat once, with its success", () => {
    const calls = acpToolCallsFrom([
      { role: "user", parts: [{ type: "text", text: "go" }] },
      {
        role: "agent",
        parts: [
          { type: "tool-call", toolCallId: "e1", toolId: "libi:libi.list_pieces", rawTitle: "mcp.libi.libi.list_pieces", startedAt: 5 },
          { type: "tool-result", toolCallId: "e1", success: true },
          { type: "tool-call", toolCallId: "e2", toolId: null, rawTitle: "Read file 'x'" },
          { type: "tool-result", toolCallId: "e2", success: false },
          { type: "text", text: "done" },
        ],
      },
    ]);
    expect(calls).toEqual([
      { toolCallId: "e1", toolId: "libi:libi.list_pieces", title: "mcp.libi.libi.list_pieces", startedAt: 5, success: true },
      { toolCallId: "e2", toolId: null, title: "Read file 'x'", success: false },
    ]);
  });
});

describe("a Codex run's report", () => {
  const result = (dir: string): RunResult => ({
    scenarioId: "bench-demo",
    agent: "codex",
    status: "completed",
    hardPass: true,
    vacuous: false,
    cliVersion: "0.155.0",
    reportDir: dir,
    assertions: [],
    durationSec: 70,
    cost: null,
    turnWindows: [
      { startedAt: "2026-10-03T00:00:10.000Z", endedAt: "2026-10-03T00:00:55.000Z" },
      { startedAt: "2026-10-03T00:01:00.000Z", endedAt: "2026-10-03T00:01:30.000Z" },
    ],
  });

  it("writes the rollouts, the studio's tool calls and Codex metrics, and bench-metrics reads them back", () => {
    const dir = mk();
    const r = result(dir);
    const toolCalls: AcpToolCall[] = [
      { toolId: "libi:libi.update_overlay", startedAt: Date.parse("2026-10-03T00:00:22.000Z") },
      { toolId: "libi:libi.update_overlay", startedAt: Date.parse("2026-10-03T00:00:23.000Z") },
    ];
    writeRunReport(dir, { result: r, trace: [], transcript: "", agentLogs: [{ path: "codex/2026/10/03/rollout-a.jsonl", content: ROLLOUT }], toolCalls });
    expect(existsSync(join(dir, "agent-jsonl", "codex", "2026", "10", "03", "rollout-a.jsonl"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "acp-tool-calls.json"), "utf8"))).toHaveLength(2);
    expect(r.metrics?.apiTurns).toBe(4);
    expect(r.metrics?.codex).toMatchObject({ execCalls: 3, libiCalls: 2, nestedSource: "executed" });

    const m = metricsForReportDir(dir);
    expect(m.agent).toBe("codex");
    expect(m.success).toBe(true);
    expect(m.cost).toBeNull();
    expect(m.perTurn.map((t) => t.wallSec)).toEqual([45, 30]);
    expect(m.toolsByName["libi.update_overlay"]).toBe(2);

    const summary = formatStdoutSummary(r);
    expect(summary.split("\n")[0]).toMatch(/\(codex\): HARD-PASS · codex 0\.155\.0$/);
    expect(summary).toMatch(/4 API turns/);
    expect(summary).toMatch(/codex: 3 exec scripts · 2 libi calls \(executed\)/);
  });
});
