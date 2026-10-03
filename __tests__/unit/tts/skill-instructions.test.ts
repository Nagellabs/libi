import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/** The skills' side (local Kokoro is the default voice) is an invariant in
 *  `__tests__/unit/skills/skill-invariants.test.ts`. */
describe("tts instruction wiring", () => {
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
