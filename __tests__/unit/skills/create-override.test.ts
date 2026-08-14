import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { and, eq } from "drizzle-orm";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";
import { createSkillOverride, getOverrideBaseDir } from "@/mcp/skills/create-override";
import { computeSkillDirDigest } from "@/mcp/skills/digest";

const NAME = "ai-asset-generation";

describe("createSkillOverride", () => {
  let bundledRoot: string;
  let userRoot: string;
  let prevHome: string | undefined;
  let prevCwd: string;
  let bundledDir: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ov-bundled-"));
    userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ov-home-"));
    bundledDir = path.join(bundledRoot, "mcp", "skills", NAME);
    fs.mkdirSync(path.join(bundledDir, "prompts"), { recursive: true });
    fs.writeFileSync(
      path.join(bundledDir, "SKILL.md"),
      `---\nname: ${NAME}\ndescription: bundled desc\n---\nBundled body\n`,
    );
    fs.writeFileSync(path.join(bundledDir, "prompts", "hook.md"), "hook v1");
    process.chdir(bundledRoot);
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = userRoot;
    createTestDb();
    getDb()
      .insert(skills)
      .values({
        id: NAME,
        name: NAME,
        description: "bundled desc",
        source: "bundled",
        enabled: true,
      })
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

  it("creates the user row stamped with the bundled digest", async () => {
    const res = await createSkillOverride(NAME);
    expect(res.ok).toBe(true);
    const row = getDb()
      .select()
      .from(skills)
      .where(and(eq(skills.name, NAME), eq(skills.source, "user")))
      .get();
    expect(row).toBeTruthy();
    expect(row!.forkedFromDigest).toBe(computeSkillDirDigest(bundledDir));
    expect(row!.body).toContain("Bundled body");
  });

  it("writes the base snapshot outside the skill folder", async () => {
    await createSkillOverride(NAME);
    const baseDir = getOverrideBaseDir(NAME);
    expect(fs.readFileSync(path.join(baseDir, "SKILL.md"), "utf-8")).toContain("Bundled body");
    expect(fs.readFileSync(path.join(baseDir, "prompts", "hook.md"), "utf-8")).toBe("hook v1");
    // The base snapshot must live OUTSIDE the skill folder, else it leaks
    // into the agent workspace mirror. Assert nothing base-like is nested inside.
    expect(fs.existsSync(path.join(userRoot, "skills", NAME, ".bases"))).toBe(false);
    expect(fs.existsSync(path.join(userRoot, "skills", NAME, ".bundled-base"))).toBe(false);
    // And the real base dir is a sibling, not a child, of the skill folder.
    expect(getOverrideBaseDir(NAME).startsWith(path.join(userRoot, "skills", NAME) + path.sep)).toBe(false);
  });

  it("with body: user copy gets the new body, base keeps the bundled one", async () => {
    const newBody = `---\nname: ${NAME}\ndescription: edited\n---\nEdited body\n`;
    const res = await createSkillOverride(NAME, { body: newBody });
    expect(res.ok).toBe(true);
    const userSkillMd = fs.readFileSync(
      path.join(userRoot, "skills", NAME, "SKILL.md"),
      "utf-8",
    );
    expect(userSkillMd).toContain("Edited body");
    expect(
      fs.readFileSync(path.join(getOverrideBaseDir(NAME), "SKILL.md"), "utf-8"),
    ).toContain("Bundled body");
    const row = getDb()
      .select()
      .from(skills)
      .where(and(eq(skills.name, NAME), eq(skills.source, "user")))
      .get();
    expect(row!.description).toBe("edited");
  });

  it("rejects when no bundled skill of that name exists", async () => {
    const res = await createSkillOverride("nope");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("nope");
  });

  it("rejects when already forked", async () => {
    await createSkillOverride(NAME);
    const res = await createSkillOverride(NAME);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already");
  });

  it("rejects an invalid body", async () => {
    const res = await createSkillOverride(NAME, { body: "no frontmatter here" });
    expect(res.ok).toBe(false);
  });
});
