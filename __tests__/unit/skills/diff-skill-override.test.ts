import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";

vi.mock("@/mcp/skills/sync-workspace", () => ({
  syncSkillsToWorkspace: vi.fn().mockResolvedValue(undefined),
}));

import { forkSkill, diffSkillOverride } from "@/mcp/tools/skill-tools";

const NAME = "ai-asset-generation";
const ctx = { pieceId: "" };

describe("diffSkillOverride", () => {
  let bundledRoot: string;
  let userRoot: string;
  let prevHome: string | undefined;
  let prevCwd: string;
  let bundledDir: string;

  beforeEach(async () => {
    prevCwd = process.cwd();
    bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "diff-bundled-"));
    userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "diff-home-"));
    bundledDir = path.join(bundledRoot, "mcp", "skills", NAME);
    fs.mkdirSync(path.join(bundledDir, "prompts"), { recursive: true });
    fs.writeFileSync(
      path.join(bundledDir, "SKILL.md"),
      `---\nname: ${NAME}\ndescription: d\n---\nv1 body\n`,
    );
    fs.writeFileSync(path.join(bundledDir, "prompts", "hook.md"), "hook v1");
    process.chdir(bundledRoot);
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = userRoot;
    createTestDb();
    getDb()
      .insert(skills)
      .values({ id: NAME, name: NAME, description: "d", source: "bundled", enabled: true })
      .run();
    await forkSkill(ctx, { id: NAME });
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    resetTestDb();
    fs.rmSync(bundledRoot, { recursive: true, force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  });

  it("no upstream change: upstreamChanged false, changedFiles empty", async () => {
    const res = JSON.parse((await diffSkillOverride(ctx, { name: NAME })).content[0].text);
    expect(res.upstreamChanged).toBe(false);
    expect(res.changedFiles).toEqual([]);
  });

  it("upstream change: reports changed files and all three SKILL.md versions", async () => {
    fs.writeFileSync(
      path.join(bundledDir, "SKILL.md"),
      `---\nname: ${NAME}\ndescription: d\n---\nv2 body\n`,
    );
    fs.writeFileSync(path.join(bundledDir, "prompts", "hook.md"), "hook v2");
    const res = JSON.parse((await diffSkillOverride(ctx, { name: NAME })).content[0].text);
    expect(res.upstreamChanged).toBe(true);
    expect(res.changedFiles.sort()).toEqual(["SKILL.md", path.join("prompts", "hook.md")].sort());
    expect(res.skillMd.base).toContain("v1 body");
    expect(res.skillMd.currentBundled).toContain("v2 body");
    expect(res.skillMd.userCopy).toContain("v1 body");
  });

  it("errors when the skill is not overridden", async () => {
    const res = await diffSkillOverride(ctx, { name: "not-overridden" });
    expect(res.error).toBeTruthy();
  });
});
