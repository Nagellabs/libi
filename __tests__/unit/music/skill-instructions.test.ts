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
  /** The exhaustive pins (Stage 6 verbatim, both references, the gate) are in
   *  `__tests__/unit/skills/recreate-skills.test.ts`; these two are the music domain's own
   *  check that the default did not quietly become a paid provider. */
  it("music-creation defaults to the local model and defers paid providers", () => {
    const md = fs.readFileSync(
      path.resolve("mcp/skills/music-creation/SKILL.md"),
      "utf-8",
    );
    expect(md).toContain("libi.generate_music");
    expect(md).toMatch(/local ACE-Step \(default, recommended\)/);
    expect(md).not.toContain("ELEVENLABS_API_KEY");
    expect(md).not.toContain("FAL_KEY");
    expect(md).toContain("references/providers/");
  });
  it("music-creation ships references for both paid music providers", () => {
    const dir = "mcp/skills/music-creation/references/providers";
    expect(
      fs.readFileSync(path.resolve(dir, "elevenlabs.md"), "utf-8"),
    ).toContain("compose_music");
    expect(fs.readFileSync(path.resolve(dir, "fal.md"), "utf-8")).toMatch(
      /Stable Audio/i,
    );
  });
});
