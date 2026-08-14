import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { and, eq } from "drizzle-orm";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";
import { getOverrideBaseDir } from "@/mcp/skills/create-override";

vi.mock("@/mcp/skills/sync-workspace", () => ({
  syncSkillsToWorkspace: vi.fn().mockResolvedValue(undefined),
}));

import { forkSkill, removeSkill } from "@/mcp/tools/skill-tools";

const NAME = "ai-asset-generation";
const ctx = { pieceId: "" };

describe("forkSkill via createSkillOverride", () => {
  let bundledRoot: string;
  let userRoot: string;
  let prevHome: string | undefined;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fork-bundled-"));
    userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fork-home-"));
    fs.mkdirSync(path.join(bundledRoot, "mcp", "skills", NAME), { recursive: true });
    fs.writeFileSync(
      path.join(bundledRoot, "mcp", "skills", NAME, "SKILL.md"),
      `---\nname: ${NAME}\ndescription: bundled desc\n---\nBundled body\n`,
    );
    process.chdir(bundledRoot);
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = userRoot;
    createTestDb();
    getDb()
      .insert(skills)
      .values({ id: NAME, name: NAME, description: "bundled desc", source: "bundled", enabled: true })
      .run();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    resetTestDb();
    fs.rmSync(bundledRoot, { recursive: true, force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  });

  it("fork stamps forkedFromDigest and writes the base snapshot", async () => {
    const res = JSON.parse((await forkSkill(ctx, { id: NAME })).content[0].text);
    expect(res.forkedFrom).toBe("bundled");
    const row = getDb()
      .select()
      .from(skills)
      .where(and(eq(skills.name, NAME), eq(skills.source, "user")))
      .get();
    expect(row!.forkedFromDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(getOverrideBaseDir(NAME), "SKILL.md"))).toBe(true);
  });

  it("removeSkill (revert) deletes the base snapshot too", async () => {
    const forkRes = JSON.parse((await forkSkill(ctx, { id: NAME })).content[0].text);
    await removeSkill(ctx, { id: forkRes.id });
    expect(fs.existsSync(getOverrideBaseDir(NAME))).toBe(false);
    expect(fs.existsSync(path.join(userRoot, "skills", NAME))).toBe(false);
  });

  it("forking twice fails with the existing error message", async () => {
    await forkSkill(ctx, { id: NAME });
    const res = await forkSkill(ctx, { id: NAME });
    expect(res.error).toContain("already forked");
  });
});
