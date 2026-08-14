import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("local-tts install plan", () => {
  it("documents the download → mark-installed → generate flow", () => {
    const md = fs.readFileSync(
      path.resolve("mcp/bundled-mcps/plans/local-tts.md"),
      "utf-8",
    );
    expect(md).toContain("libi.tts_download_model");
    expect(md).toContain('update_dep_status({ mcpId: "local-tts"');
    expect(md).toContain("libi.generate_speech");
    expect(md).toContain("ElevenLabs");
  });
});
