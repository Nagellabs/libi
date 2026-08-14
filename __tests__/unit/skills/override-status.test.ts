import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { computeOverrideStatus } from "@/mcp/skills/override-status";
import { computeSkillDirDigest } from "@/mcp/skills/digest";

const NAME = "ai-asset-generation";

describe("computeOverrideStatus", () => {
  let bundledRoot: string;
  let prevCwd: string;
  let bundledDir: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "status-bundled-"));
    bundledDir = path.join(bundledRoot, "mcp", "skills", NAME);
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.writeFileSync(
      path.join(bundledDir, "SKILL.md"),
      `---\nname: ${NAME}\ndescription: d\n---\nv1`,
    );
    process.chdir(bundledRoot);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(bundledRoot, { recursive: true, force: true });
  });

  const bundledRow = { name: NAME, source: "bundled" as const, forkedFromDigest: null };

  it("fresh fork (digest matches): not stale", () => {
    const digest = computeSkillDirDigest(bundledDir);
    const status = computeOverrideStatus([
      bundledRow,
      { name: NAME, source: "user", forkedFromDigest: digest },
    ]);
    expect(status.get(NAME)).toEqual({
      overridesBundled: true,
      bundledUpdatedSinceFork: false,
    });
  });

  it("bundled changed after fork: stale", () => {
    const digest = computeSkillDirDigest(bundledDir);
    fs.writeFileSync(
      path.join(bundledDir, "SKILL.md"),
      `---\nname: ${NAME}\ndescription: d\n---\nv2`,
    );
    const status = computeOverrideStatus([
      bundledRow,
      { name: NAME, source: "user", forkedFromDigest: digest },
    ]);
    expect(status.get(NAME)!.bundledUpdatedSinceFork).toBe(true);
  });

  it("pre-feature fork (no digest): unknown", () => {
    const status = computeOverrideStatus([
      bundledRow,
      { name: NAME, source: "user", forkedFromDigest: null },
    ]);
    expect(status.get(NAME)!.bundledUpdatedSinceFork).toBe("unknown");
  });

  it("plain user skill (no bundled twin): no entry", () => {
    const status = computeOverrideStatus([
      { name: "my-own-skill", source: "user", forkedFromDigest: null },
    ]);
    expect(status.has("my-own-skill")).toBe(false);
  });
});
