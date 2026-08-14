import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("tts tool registration", () => {
  it("server.ts registers the three tts tools", () => {
    const src = fs.readFileSync(path.resolve("mcp/server.ts"), "utf-8");
    expect(src).toContain('"libi.generate_speech"');
    expect(src).toContain('"libi.tts_list_voices"');
    expect(src).toContain('"libi.tts_download_model"');
  });
  it("tts-tools is barrel-exported", () => {
    const idx = fs.readFileSync(path.resolve("mcp/tools/index.ts"), "utf-8");
    expect(idx).toContain('export * from "./tts-tools"');
  });
});
