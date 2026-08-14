import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("local-music install plan", () => {
  it("documents size disclosure → download → mark-installed → generate", () => {
    const md = fs.readFileSync(
      path.resolve("mcp/bundled-mcps/plans/local-music.md"),
      "utf-8",
    );
    expect(md).toMatch(/~5\.5 GB/);
    expect(md).toContain("libi.music_download_model");
    expect(md).toContain('update_dep_status({ mcpId: "local-music"');
    expect(md).toContain("libi.generate_music");
    expect(md).toMatch(/force: true/);
  });
});
