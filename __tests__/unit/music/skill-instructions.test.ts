import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("music skill + instruction wiring", () => {
  it("ai-asset-generation skill makes local-music the music default", () => {
    const md = fs.readFileSync(
      path.resolve("mcp/skills/ai-asset-generation/SKILL.md"),
      "utf-8",
    );
    expect(md).toContain("libi.generate_music");
    expect(md).toContain("local-music");
  });
  it("skills registry mentions local ACE-Step music default", () => {
    const src = fs.readFileSync(
      path.resolve("mcp/skills/registry.ts"),
      "utf-8",
    );
    expect(src).toMatch(/ACE-Step|local.*music/i);
  });
  it("instructions reference generate_music + music tools", () => {
    const md = fs.readFileSync(
      path.resolve("mcp/templates/instructions.md"),
      "utf-8",
    );
    expect(md).toContain("libi.generate_music");
    expect(md).toContain("libi.music_list_styles");
    expect(md).toContain("libi.music_download_model");
  });
});
