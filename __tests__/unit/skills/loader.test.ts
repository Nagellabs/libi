import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";
import { loadEnabledSkills } from "@/mcp/skills/loader";

describe("loadEnabledSkills", () => {
  let bundledRoot: string;
  let userRoot: string;
  let prevHome: string | undefined;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skills-bundled-"));
    userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skills-user-"));
    fs.mkdirSync(path.join(bundledRoot, "mcp", "skills", "ai-asset-generation"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(bundledRoot, "mcp", "skills", "ai-asset-generation", "SKILL.md"),
      `---\nname: ai-asset-generation\ndescription: bundled body\n---\nBundled body\n`,
    );
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

  it("loads bundled skill from disk", async () => {
    getDb()
      .insert(skills)
      .values({
        id: "ai-asset-generation",
        name: "ai-asset-generation",
        description: "bundled body",
        source: "bundled",
        enabled: true,
      })
      .run();

    const list = await loadEnabledSkills();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("ai-asset-generation");
    expect(list[0].body).toContain("Bundled body");
    expect(list[0].source).toBe("bundled");
  });

  it("user skill shadows bundled with same name", async () => {
    getDb()
      .insert(skills)
      .values([
        {
          id: "ai-asset-generation",
          name: "ai-asset-generation",
          description: "bundled body",
          source: "bundled",
          enabled: true,
        },
        {
          id: "user-shadow",
          name: "ai-asset-generation",
          description: "user body",
          source: "user",
          enabled: true,
          body: "---\nname: ai-asset-generation\ndescription: user body\n---\nUser body\n",
        },
      ])
      .run();

    const list = await loadEnabledSkills();
    expect(list).toHaveLength(1);
    expect(list[0].source).toBe("user");
    expect(list[0].body).toContain("User body");
  });

  it("user shadowing works regardless of insertion order (user inserted first)", async () => {
    getDb()
      .insert(skills)
      .values([
        {
          id: "user-shadow",
          name: "ai-asset-generation",
          description: "user body",
          source: "user",
          enabled: true,
          body: "---\nname: ai-asset-generation\ndescription: user body\n---\nUser body\n",
        },
        {
          id: "ai-asset-generation",
          name: "ai-asset-generation",
          description: "bundled body",
          source: "bundled",
          enabled: true,
        },
      ])
      .run();

    const list = await loadEnabledSkills();
    expect(list).toHaveLength(1);
    expect(list[0].source).toBe("user");
    expect(list[0].body).toContain("User body");
  });

  it("filters out disabled skills", async () => {
    getDb()
      .insert(skills)
      .values({
        id: "ai-asset-generation",
        name: "ai-asset-generation",
        description: "x",
        source: "bundled",
        enabled: false,
      })
      .run();

    const list = await loadEnabledSkills();
    expect(list).toHaveLength(0);
  });

  it("reads unknown-extension files as Buffer (avoids utf-8 corruption)", async () => {
    // Set up a bundled skill on disk with an SVG supporting file
    const skillDir = path.join(bundledRoot, "mcp", "skills", "with-svg");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: with-svg\ndescription: x\n---\nBody.\n`,
    );
    // Write a file with high-byte content that would be mangled by utf-8 read
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(path.join(skillDir, "icon.svg"), binary);

    getDb().insert(skills).values({
      id: "with-svg",
      name: "with-svg",
      description: "x",
      source: "bundled",
      enabled: true,
    }).run();

    const list = await loadEnabledSkills();
    const skill = list.find((s) => s.name === "with-svg");
    expect(skill).toBeDefined();
    const svg = skill!.supportingFiles.find((f) => f.relPath === "icon.svg");
    expect(svg).toBeDefined();
    expect(Buffer.isBuffer(svg!.contents)).toBe(true);
    expect((svg!.contents as Buffer).equals(binary)).toBe(true);
  });
});
