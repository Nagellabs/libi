import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/** The skills' side (local ACE-Step is the default, a paid provider only as an option, the paid references'
 *  call mechanics) is checked as invariants in `__tests__/unit/skills/skill-invariants.test.ts`. */
describe("music instruction wiring", () => {
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
