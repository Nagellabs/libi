import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { ACESTEP_DOWNLOAD_SIZE_HUMAN } from "@/lib/music/models";

describe("local-music install plan", () => {
  it("documents size disclosure → download → mark-installed → generate", () => {
    const md = fs.readFileSync(
      path.resolve("mcp/bundled-mcps/plans/local-music.md"),
      "utf-8",
    );
    // Asserted against the CONSTANT, not a literal. This test used to pin
    // "~5.5 GB" by hand, so when the real measured size turned out to be 8.3 GB
    // the plan and the code could disagree while the test still passed on the
    // stale number. The figure is what the user consents to — it has to be one
    // value, defined once.
    expect(md).toContain(ACESTEP_DOWNLOAD_SIZE_HUMAN);
    expect(md).toContain("libi.music_download_model");
    expect(md).toContain('update_dep_status({ mcpId: "local-music"');
    expect(md).toContain("libi.generate_music");
    expect(md).toMatch(/force: true/);
  });
});
