import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { forkSkill, addSkillPrompt, listSkillPrompts } from "@/mcp/tools/skill-tools";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";
import { seedDatabase } from "@/lib/db/init";
import { eq, and } from "drizzle-orm";

describe("forkSkill", () => {
  let homeRoot: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-fork-"));
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = homeRoot;
    createTestDb();
    seedDatabase(getDb() as never);
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    resetTestDb();
    fs.rmSync(homeRoot, { recursive: true, force: true });
  });

  it("forks a bundled skill into a user copy", async () => {
    // 1. Find the bundled ai-asset-generation row
    const bundledRow = getDb()
      .select()
      .from(skills)
      .where(and(eq(skills.name, "ai-asset-generation"), eq(skills.source, "bundled")))
      .get();
    expect(bundledRow).toBeDefined();

    // 2. Fork it
    const res = await forkSkill({} as never, { id: bundledRow!.id });
    const data = JSON.parse(res.content[0].text);
    expect(res.error).toBeUndefined();
    expect(data.error).toBeUndefined();
    expect(data.name).toBe("ai-asset-generation");
    expect(data.forkedFrom).toBe("bundled");

    // 3. User row now exists for ai-asset-generation (source="user")
    const userRow = getDb()
      .select()
      .from(skills)
      .where(and(eq(skills.name, "ai-asset-generation"), eq(skills.source, "user")))
      .get();
    expect(userRow).toBeDefined();
    expect(userRow!.body).toBeTruthy();

    // 4. SKILL.md exists on disk under LIBI_HOME/skills/
    const skillFile = path.join(homeRoot, "skills", "ai-asset-generation", "SKILL.md");
    expect(fs.existsSync(skillFile)).toBe(true);
  });

  it("rejects double-fork (bundled id forked again)", async () => {
    const bundledRow = getDb()
      .select()
      .from(skills)
      .where(and(eq(skills.name, "ai-asset-generation"), eq(skills.source, "bundled")))
      .get();
    expect(bundledRow).toBeDefined();

    // First fork succeeds
    const first = await forkSkill({} as never, { id: bundledRow!.id });
    expect(first.error).toBeUndefined();

    // Second fork rejected
    const second = await forkSkill({} as never, { id: bundledRow!.id });
    const data = JSON.parse(second.content[0].text);
    expect(second.error ?? data.error).toBeTruthy();
    expect(String(data.error)).toContain("already forked");
  });

  it("rejects forking a non-bundled skill", async () => {
    // Insert a user skill row directly
    getDb()
      .insert(skills)
      .values({
        id: "user-skill-1",
        name: "my-user-skill",
        description: "user",
        source: "user",
        enabled: true,
        body: "---\nname: my-user-skill\ndescription: user\n---\nBody.\n",
      })
      .run();

    const res = await forkSkill({} as never, { id: "user-skill-1" });
    const data = JSON.parse(res.content[0].text);
    expect(res.error ?? data.error).toBeTruthy();
  });

  it("returns error for unknown skill id", async () => {
    const res = await forkSkill({} as never, { id: "nonexistent-id" });
    const data = JSON.parse(res.content[0].text);
    expect(res.error ?? data.error).toBeTruthy();
  });

  it("can add and list a prompt on a forked skill (bundled + user rows share the name)", async () => {
    // Regression: a forked skill has BOTH a bundled and a user row. Prompt tools
    // must resolve the USER row, not reject as "bundled".
    const bundledRow = getDb()
      .select()
      .from(skills)
      .where(and(eq(skills.name, "ai-asset-generation"), eq(skills.source, "bundled")))
      .get();
    await forkSkill({} as never, { id: bundledRow!.id });

    const add = JSON.parse(
      (await addSkillPrompt({} as never, { skillName: "ai-asset-generation", name: "qa-note", body: "# QA" })).content[0].text,
    );
    expect(add.error).toBeUndefined();
    expect(add.relPath).toBe("prompts/qa-note.md");

    const listed = JSON.parse(
      (await listSkillPrompts({} as never, { skillName: "ai-asset-generation" })).content[0].text,
    );
    expect(listed.prompts.map((p: { relPath: string }) => p.relPath)).toContain("prompts/qa-note.md");

    // The prompt landed under the USER copy on disk.
    expect(
      fs.existsSync(path.join(homeRoot, "skills", "ai-asset-generation", "prompts", "qa-note.md")),
    ).toBe(true);
  });
});
