/**
 * Spec 2026-09-29 §A2: exports are saved in the piece; the export-folder
 * setting is gone. A reader that comes back would write exports outside
 * libi's storage again.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

describe("the export-folder setting is gone", () => {
  it("no source file names the old folder resolver, default or its API fields", () => {
    const res = spawnSync(
      "git",
      ["grep", "-n", "-E", "resolveExportFolder|defaultExportFolder|osDefaultFolder|effectiveFolder|lib/export/folder", "--", "app", "lib", "components", "hooks", "mcp", "electron", "bin", "scripts"],
      { encoding: "utf8", cwd: process.cwd() },
    );
    // git grep exits 1 with no output when nothing matches.
    expect(res.stdout).toBe("");
    expect(res.status).toBe(1);
  });
});
