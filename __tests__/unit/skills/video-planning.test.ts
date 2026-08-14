import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { BUNDLED_SKILLS } from "../../../mcp/skills/registry";

const skillsDir = path.resolve(__dirname, "../../../mcp/skills");
const read = (rel: string) => readFileSync(path.join(skillsDir, rel), "utf8");

describe("video-planning skill", () => {
  it("is registered in BUNDLED_SKILLS", () => {
    expect(BUNDLED_SKILLS.some((s) => s.id === "video-planning")).toBe(true);
  });

  it("ships SKILL.md + the build-breakdown prompt fragment", () => {
    expect(existsSync(path.join(skillsDir, "video-planning/SKILL.md"))).toBe(true);
    expect(
      existsSync(path.join(skillsDir, "video-planning/prompts/build-breakdown.md")),
    ).toBe(true);
  });

  it("SKILL.md is a reference skill teaching plan → direct, not a standalone entry", () => {
    const md = read("video-planning/SKILL.md");
    expect(md).toMatch(/name:\s*video-planning/);
    expect(md).toMatch(/not a standalone entry point/i);
    // The three entry modes.
    expect(md).toMatch(/Extract/);
    expect(md).toMatch(/Reuse/);
    expect(md).toMatch(/Create/);
    // The per-block decision framework axes.
    expect(md).toMatch(/source-vs-AI|Source/i);
    expect(md).toMatch(/[Cc]ombine vs\.? split/);
    expect(md).toMatch(/[Ss]tyle inheritance/);
    // Plan-as-a-skill capture via add_skill.
    expect(md).toMatch(/add_skill/);
  });

  it("the build-breakdown fragment carries the worked example + block→card mapping", () => {
    const md = read("video-planning/prompts/build-breakdown.md");
    expect(md).toMatch(/reference_video/);
    expect(md).toMatch(/card/i);
    // The combine-vs-split anti-fragmentation rule.
    expect(md).toMatch(/fewest model-max/i);
  });
});

describe("video-planning is wired into the creation flow", () => {
  it("mimic-video extracts a plan via video-planning in Step 3", () => {
    const md = read("mimic-video/SKILL.md");
    expect(md).toMatch(/video-planning/);
    expect(md).toMatch(/build plan|build algorithm/i);
  });

  it("generic-video plans first via video-planning", () => {
    expect(read("generic-video/SKILL.md")).toMatch(/video-planning/);
  });

  it("ugc-product-video plans the ad into blocks via video-planning", () => {
    expect(read("ugc-product-video/SKILL.md")).toMatch(/video-planning/);
  });

  it("music-video-creation plans the visuals via video-planning", () => {
    expect(read("music-video-creation/SKILL.md")).toMatch(/video-planning/);
  });

  it("using-storyboard names video-planning as the layer above the board", () => {
    const md = read("using-storyboard/SKILL.md");
    expect(md).toMatch(/video-planning/);
    expect(md).toMatch(/planning above|the director|layer above/i);
  });
});
