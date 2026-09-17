/**
 * `agent-eval/TEST-PLAN.md`'s run-order table drifted from
 * `agent-eval/scenarios/`: it still listed `06-bundled-mcp-youtube.md` and
 * `08-generation-approval.md`, both deleted with libi's managed MCPs, and it
 * never gained 11 and 12. A plan that names scenarios nobody can run — and
 * omits ones that exist — sends a QA run looking for missing files and lets
 * real scenarios go unrun.
 *
 * The table IS the run order (the scenarios build state for each other), so
 * the invariant is a bijection, not a subset.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "agent-eval");

function scenarioFiles(): string[] {
  return readdirSync(join(ROOT, "scenarios"))
    .filter((f) => f.endsWith(".md"))
    .sort();
}

function tabledFiles(): string[] {
  const plan = readFileSync(join(ROOT, "TEST-PLAN.md"), "utf8");
  return [...plan.matchAll(/^\|\s*\d+\s*\|\s*`([^`]+\.md)`/gm)].map((m) => m[1]);
}

describe("agent-eval TEST-PLAN table", () => {
  it("lists every scenario file, and only files that exist", () => {
    expect(tabledFiles().slice().sort()).toEqual(scenarioFiles());
  });

  it("lists them in run order — the order the scenarios' state depends on", () => {
    const tabled = tabledFiles();
    expect(tabled).toEqual(tabled.slice().sort());
  });

  it("names no scenario the branch deleted along with libi's managed MCPs", () => {
    const docs = ["TEST-PLAN.md", "README.md"]
      .map((f) => readFileSync(join(ROOT, f), "utf8"))
      .join("\n");
    expect(docs).not.toMatch(/06-bundled-mcp-youtube|08-generation-approval|scenario 08/);
  });
});
