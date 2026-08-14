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

import { updateSkill } from "@/mcp/tools/skill-tools";

const NAME = "ai-asset-generation";
const ctx = { pieceId: "" };

describe("updateSkill creates an override for a bundled skill", () => {
  let bundledRoot: string;
  let userRoot: string;
  let prevHome: string | undefined;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "upd-bundled-"));
    userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "upd-home-"));
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

  it("bundled skill with no override: creates the override with the edited body", async () => {
    const body = `---\nname: ${NAME}\ndescription: edited desc\n---\nEdited body\n`;
    const res = JSON.parse((await updateSkill(ctx, { name: NAME, body })).content[0].text);
    expect(res.success).toBe(true);
    const row = getDb()
      .select()
      .from(skills)
      .where(and(eq(skills.name, NAME), eq(skills.source, "user")))
      .get();
    expect(row!.body).toContain("Edited body");
    expect(row!.forkedFromDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      fs.readFileSync(path.join(getOverrideBaseDir(NAME), "SKILL.md"), "utf-8"),
    ).toContain("Bundled body");
  });

  it("unknown skill name still errors", async () => {
    const body = `---\nname: nope\ndescription: d\n---\nx\n`;
    const res = await updateSkill(ctx, { name: "nope", body });
    expect(res.error).toBeTruthy();
  });

  it("existing user skill: updates in place without touching forkedFromDigest", async () => {
    const body1 = `---\nname: ${NAME}\ndescription: edited desc\n---\nEdited body\n`;
    await updateSkill(ctx, { name: NAME, body: body1 });
    const digestBefore = getDb()
      .select()
      .from(skills)
      .where(and(eq(skills.name, NAME), eq(skills.source, "user")))
      .get()!.forkedFromDigest;
    const body2 = `---\nname: ${NAME}\ndescription: edited again\n---\nEdited body v2\n`;
    await updateSkill(ctx, { name: NAME, body: body2 });
    const row = getDb()
      .select()
      .from(skills)
      .where(and(eq(skills.name, NAME), eq(skills.source, "user")))
      .get();
    expect(row!.body).toContain("Edited body v2");
    expect(row!.forkedFromDigest).toBe(digestBefore);
  });
});
