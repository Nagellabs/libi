import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("music tool registration", () => {
  it("server.ts registers the three music tools", () => {
    const src = fs.readFileSync(path.resolve("mcp/server.ts"), "utf-8");
    expect(src).toContain('"libi.generate_music"');
    expect(src).toContain('"libi.music_list_styles"');
    expect(src).toContain('"libi.music_download_model"');
  });
  it("music-tools is barrel-exported", () => {
    const idx = fs.readFileSync(path.resolve("mcp/tools/index.ts"), "utf-8");
    expect(idx).toContain('export * from "./music-tools"');
  });
});
