import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseSkillBody } from "@/mcp/skills/frontmatter";

const raw = readFileSync("mcp/skills/three-overlays/SKILL.md", "utf8");
const { frontmatter, body } = parseSkillBody(raw);

describe("skill: three-overlays guidance", () => {
  it("has valid frontmatter naming the skill + 3d tag", () => {
    expect(frontmatter.name).toBe("three-overlays");
    expect(frontmatter.tags).toContain("3d");
    expect(frontmatter.description.length).toBeGreaterThan(80);
  });

  it("teaches the build-once + per-frame update contract", () => {
    expect(/build[- ]once/i.test(body)).toBe(true);
    // never create meshes in the update closure
    expect(/never create.*(inside|in) the update|NEVER create them inside/i.test(body)).toBe(true);
    // element-local progress pacing
    expect(/progress/.test(body)).toBe(true);
  });

  it("names the consolidated MCP tool, the camera presets, and the vetted templates", () => {
    expect(/libi\.add_overlay/.test(body)).toBe(true);
    // no dangling references to the removed per-kind tools
    expect(/add_three_overlay|update_three_overlay/.test(body)).toBe(false);
    expect(/cameraPreset/.test(body)).toBe(true);
    expect(/ground/.test(body) && /billboard/.test(body)).toBe(true);
    expect(/roadCaption/.test(body)).toBe(true);
    expect(/billboardCaption/.test(body)).toBe(true);
    expect(/simpleObject/.test(body)).toBe(true);
  });

  it("teaches editing the scene.jsx file directly (no code-string update tool)", () => {
    expect(/scene\.jsx/.test(body)).toBe(true);
    expect(/codeFilePath/.test(body)).toBe(true);
    expect(/edit.*file|edit.*scene\.jsx/i.test(body)).toBe(true);
  });

  it("scopes out rigs/physics/glTF and routes flat text elsewhere", () => {
    expect(/rig|physics|glTF/i.test(body)).toBe(true);
    expect(/animated-text-overlays/.test(body)).toBe(true);
    expect(/speech-captions/.test(body)).toBe(true);
  });
});
