import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";
import { loadEnabledSkills } from "@/mcp/skills/loader";

describe("loadEnabledSkills symlink safety", () => {
  let bundledRoot: string;
  let userRoot: string;
  let prevCwd: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevCwd = process.cwd();
    bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-sym-bundled-"));
    userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-sym-user-"));
    process.chdir(bundledRoot);
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = userRoot;
    createTestDb();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    resetTestDb();
    fs.rmSync(bundledRoot, { recursive: true, force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  });

  it("ignores symlinks inside a user skill directory", async () => {
    const skillDir = path.join(userRoot, "skills", "tricky");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: tricky\ndescription: tricky\n---\nBody.\n`,
    );
    fs.symlinkSync(userRoot, path.join(skillDir, "escape"));

    getDb().insert(skills).values({
      id: "tricky-id",
      name: "tricky",
      description: "tricky",
      source: "user",
      enabled: true,
      body: `---\nname: tricky\ndescription: tricky\n---\nBody.\n`,
    }).run();

    const list = await loadEnabledSkills();
    const tricky = list.find((s) => s.name === "tricky");
    expect(tricky).toBeDefined();
    expect(tricky!.supportingFiles.find((f) => f.relPath.includes("escape"))).toBeUndefined();
  });

  it("does not loop on a symlink cycle", async () => {
    const skillDir = path.join(userRoot, "skills", "loop");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: loop\ndescription: loop\n---\nBody.\n`,
    );
    fs.mkdirSync(path.join(skillDir, "a"));
    fs.symlinkSync(path.join(skillDir, "a"), path.join(skillDir, "a", "b"));

    getDb().insert(skills).values({
      id: "loop-id",
      name: "loop",
      description: "loop",
      source: "user",
      enabled: true,
      body: `---\nname: loop\ndescription: loop\n---\nBody.\n`,
    }).run();

    const start = Date.now();
    const list = await loadEnabledSkills();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(list.find((s) => s.name === "loop")).toBeDefined();
  });
});
