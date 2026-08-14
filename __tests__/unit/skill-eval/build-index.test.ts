import { describe, it, expect } from "vitest";
import { renderIndexTable } from "@/scripts/skill-eval/build-index";
import type { ParsedScenario } from "@/scripts/skill-eval/types";

function scn(over: Partial<ParsedScenario>): ParsedScenario {
  return {
    id: "x", title: "X", skills: ["s1"], mcps: ["fal-ai"], agents: ["claude-code"],
    runs: 1, timeoutSec: 300, falStrict: false, covers: ["c1"], prompt: "p", assertions: [], behavior: [],
    sourcePath: "skill-eval/scenarios/grp/01-x.md", ...over,
  };
}

describe("renderIndexTable", () => {
  it("renders a markdown table sorted by id with covers + path", () => {
    const md = renderIndexTable([
      scn({ id: "b", covers: ["gpt-image-2"] }),
      scn({ id: "a", skills: ["ugc-product-video"], covers: ["native-audio"] }),
    ]);
    expect(md).toMatch(/\| id \| title \| skills \| mcps \| covers \| path \|/);
    const aIdx = md.indexOf("| a |");
    const bIdx = md.indexOf("| b |");
    expect(aIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(bIdx); // sorted
    expect(md).toContain("native-audio");
    expect(md).toContain("skill-eval/scenarios/grp/01-x.md");
  });
});
