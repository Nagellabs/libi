import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("tts skill + instruction wiring", () => {
  it("ai-asset-generation skill makes local-tts the speech default", () => {
    const md = fs.readFileSync(
      path.resolve("mcp/skills/ai-asset-generation/SKILL.md"),
      "utf-8",
    );
    expect(md).toContain("libi.generate_speech");
    expect(md).toContain("local-tts");
  });
  it("skills registry mentions local Kokoro default", () => {
    const src = fs.readFileSync(
      path.resolve("mcp/skills/registry.ts"),
      "utf-8",
    );
    expect(src).toMatch(/Kokoro|local.*text-to-speech/i);
  });
  it("instructions reference generate_speech + tts tools", () => {
    const md = fs.readFileSync(
      path.resolve("mcp/templates/instructions.md"),
      "utf-8",
    );
    expect(md).toContain("libi.generate_speech");
    expect(md).toContain("libi.tts_list_voices");
    expect(md).toContain("libi.tts_download_model");
  });
});
