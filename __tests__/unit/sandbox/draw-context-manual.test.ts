import { describe, it, expect } from "vitest";
import { renderAgentInstructions } from "@/mcp/workspace";
import { resolveManualSection } from "@/mcp/manual-sections";
import { buildDrawBodyContext } from "@/lib/sandbox/runtime/compile";
import fs from "fs";
import path from "path";

const skill = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, "../../../mcp/skills", ...p), "utf-8");
const ANIMATED_TEXT_CONTRACT = {
  contract: skill("animated-text-overlays", "prompts", "timing-contract.md"),
  skill: skill("animated-text-overlays", "SKILL.md"),
};
const THREE_SKILL = skill("three-overlays", "SKILL.md");

const DIALECTS = ["claude", "codex"] as const;

/**
 * Under the overlay sandbox the manual's DrawContext is the exact list of what a body may read
 * (AGENTS.md "Overlay sandbox"): a field the runtime hands a body that the manual never names is
 * invisible to the agent (that is how bodies came to hard-code composition times), and a field the
 * manual names that the runtime does not hand over is a render error. Pin both directions.
 */
describe("the manual's DrawContext lists exactly what a body is handed", () => {
  const handed = Object.keys(
    buildDrawBodyContext({
      ctx: {} as CanvasRenderingContext2D,
      width: 1,
      height: 1,
      fps: 30,
      time: { frame: 0, time: 0, totalFrames: 1, duration: 1, progress: 0, compositionTime: 0, overlayStart: 0, pieceDuration: 1 },
      words: [],
      images: {},
    }),
  ).sort();

  it.each(DIALECTS)("%s", (dialect) => {
    const res = resolveManualSection(renderAgentInstructions(dialect), "the-drawcontext");
    expect(res.ok).toBe(true);
    const text = res.ok ? res.text : "";
    const block = /```\n([\s\S]*?)```/.exec(text)?.[1] ?? "";
    const documented = [...block.matchAll(/^context\.(\w+)/gm)].map((m) => m[1]!).sort();
    expect(documented).toEqual(handed);
    expect(documented).toEqual(expect.arrayContaining(["compositionTime", "overlayStart", "pieceDuration"]));
    // The one owner rule, in the section that lists the fields (inlined in the index).
    expect(text).toContain("never hard-code a composition time");
  });
});

describe("the code-overlay skills teach the same rule and the same fields", () => {
  it("animated-text-overlays: the timing contract tables the three fields; the skill says never hard-code", () => {
    for (const f of ["compositionTime", "overlayStart", "pieceDuration"]) expect(ANIMATED_TEXT_CONTRACT.contract).toContain(f);
    expect(ANIMATED_TEXT_CONTRACT.contract).toContain("Never hard-code a composition time in a body");
    expect(ANIMATED_TEXT_CONTRACT.skill).toContain("Never hard-code a composition time in a");
  });
  it("three-overlays: the per-frame update carries them", () => {
    expect(THREE_SKILL).toMatch(/compositionTime,\s+overlayStart,\s+pieceDuration/);
    expect(THREE_SKILL).toContain("Never hard-code a composition time in a");
  });
});
