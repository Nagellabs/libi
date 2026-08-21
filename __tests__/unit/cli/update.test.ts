import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  createTempStorageDir,
  cleanupTempDir,
} from "@/__tests__/helpers/test-storage";
import { LIBI_SKILL_VERSION } from "@/mcp/version";

// Suppress console output during tests
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

function setupMinimalProject(dir: string) {
  // Create a minimal CLAUDE.md so updateProject doesn't exit early
  fs.writeFileSync(
    path.join(dir, "CLAUDE.md"),
    "<!-- libi-instructions-start v0.0.0 -->\n<!-- libi-instructions-end -->"
  );
}

describe("updateProject", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = createTempStorageDir();
    originalCwd = process.cwd();
    process.chdir(tempDir);
    setupMinimalProject(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanupTempDir(tempDir);
  });

  it('reports "already up to date" when CLAUDE.md marker matches LIBI_SKILL_VERSION', async () => {
    // Write a CLAUDE.md with the current version marker
    fs.writeFileSync(
      path.join(tempDir, "CLAUDE.md"),
      `<!-- libi-instructions-start v${LIBI_SKILL_VERSION} -->\n# Instructions\n<!-- libi-instructions-end -->`
    );

    const consoleSpy = vi.mocked(console.log);
    consoleSpy.mockClear();

    const { updateProject } = await import("@/lib/cli/update");
    await updateProject();

    const calls = consoleSpy.mock.calls.map((args) => args.join(" "));
    const anyCall = calls.some((msg) => msg.includes("Already up to date"));
    expect(anyCall).toBe(true);
  });

  it("updates templates when CLAUDE.md marker version is older", async () => {
    // Write a CLAUDE.md with an old version marker
    fs.writeFileSync(
      path.join(tempDir, "CLAUDE.md"),
      "<!-- libi-instructions-start v0.0.1 -->\nOLD CONTENT\n<!-- libi-instructions-end -->"
    );

    const { updateProject } = await import("@/lib/cli/update");
    await updateProject();

    // CLAUDE.md should have been updated with new instructions
    const content = fs.readFileSync(path.join(tempDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("libi.add_overlay");
    expect(content).toContain(
      `<!-- libi-instructions-start v${LIBI_SKILL_VERSION} -->`
    );
    expect(content).not.toContain("OLD CONTENT");
  });

  it("exits with error when no CLAUDE.md exists", async () => {
    // Remove CLAUDE.md created by setupMinimalProject
    fs.unlinkSync(path.join(tempDir, "CLAUDE.md"));

    const { updateProject } = await import("@/lib/cli/update");
    await expect(updateProject()).rejects.toThrow();

    const errorCalls = vi.mocked(console.error).mock.calls.map((args) => args.join(" "));
    expect(errorCalls.some((msg) => msg.includes("Not a Libi project"))).toBe(true);
  });

  it("creates AGENTS.md alongside CLAUDE.md during update", async () => {
    fs.writeFileSync(
      path.join(tempDir, "CLAUDE.md"),
      "<!-- libi-instructions-start v0.0.1 -->\nOLD\n<!-- libi-instructions-end -->"
    );

    const { updateProject } = await import("@/lib/cli/update");
    await updateProject();

    expect(fs.existsSync(path.join(tempDir, "AGENTS.md"))).toBe(true);
    const content = fs.readFileSync(path.join(tempDir, "AGENTS.md"), "utf-8");
    expect(content).toContain("libi.add_overlay");
  });
});
