import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { skills as skillsTable } from "@/lib/db/schema";
import { loadEnabledSkills } from "@/mcp/skills/loader";
import { BUNDLED_SKILLS } from "@/mcp/skills/registry";
import { writeSkillsToWorkspace } from "@/mcp/skills/writer";
import type { Skill } from "@/mcp/skills/types";

/** references/providers/<id>.md must reach BOTH agent dialects. The loader
 *  walks a skill dir recursively (mcp/skills/loader.ts#readSupportingFiles) and
 *  the writer creates parent dirs for every relPath — a refactor that scopes
 *  either to `prompts/` silently strips every provider reference. */

function makeSkill(): Skill {
  return {
    id: "demo",
    name: "demo",
    description: "demo",
    source: "bundled",
    enabled: true,
    body: "---\nname: demo\ndescription: demo\n---\n\n# Demo\n",
    frontmatter: { name: "demo", description: "demo" },
    supportingFiles: [
      { relPath: "prompts/thing.md", contents: "prompt body" },
      { relPath: path.join("references", "providers", "fal.md"), contents: "FAL REFERENCE BODY" },
      { relPath: path.join("references", "providers", "elevenlabs.md"), contents: "EL REFERENCE BODY" },
    ],
    tags: [],
  };
}

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "libi-refs-"));
});
afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("provider reference mirroring", () => {
  it("writes references/providers/*.md into both dialects", async () => {
    await writeSkillsToWorkspace(workspace, [makeSkill()]);
    for (const dialect of [".claude/skills", ".agents/skills"]) {
      const fal = path.join(workspace, dialect, "demo", "references", "providers", "fal.md");
      const el = path.join(workspace, dialect, "demo", "references", "providers", "elevenlabs.md");
      expect(fs.existsSync(fal), `${dialect}: fal.md missing`).toBe(true);
      expect(fs.readFileSync(fal, "utf-8")).toBe("FAL REFERENCE BODY");
      expect(fs.readFileSync(el, "utf-8")).toBe("EL REFERENCE BODY");
    }
  });

  it("removes a reference file that is no longer in supportingFiles", async () => {
    await writeSkillsToWorkspace(workspace, [makeSkill()]);
    const trimmed = makeSkill();
    trimmed.supportingFiles = trimmed.supportingFiles.filter(
      (f) => !f.relPath.endsWith("elevenlabs.md"),
    );
    await writeSkillsToWorkspace(workspace, [trimmed]);
    expect(
      fs.existsSync(path.join(workspace, ".claude/skills/demo/references/providers/elevenlabs.md")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(workspace, ".claude/skills/demo/references/providers/fal.md")),
    ).toBe(true);
  });
});

/** The loader half: a bundled skill's nested references/ file becomes a
 *  supportingFiles entry with its nested relPath intact, and the sibling
 *  `mcp/skills/_shared/` source-of-truth folder (no registry row) is never
 *  loaded as a skill. */
describe("loader picks up nested references/ for a bundled skill", () => {
  let bundledRoot: string;
  let userRoot: string;
  let prevHome: string | undefined;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "libi-refs-bundled-"));
    userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "libi-refs-home-"));
    const skillDir = path.join(bundledRoot, "mcp", "skills", "demo");
    fs.mkdirSync(path.join(skillDir, "references", "providers"), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: demo\ndescription: demo\n---\n\n# Demo\n",
    );
    fs.writeFileSync(path.join(skillDir, "references", "providers", "fal.md"), "FAL REFERENCE BODY");
    const shared = path.join(bundledRoot, "mcp", "skills", "_shared");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, "provider-gate.md"), "GATE SOURCE OF TRUTH");
    process.chdir(bundledRoot);
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = userRoot;
    createTestDb();
    getDb()
      .insert(skillsTable)
      .values({ id: "demo", name: "demo", description: "demo", source: "bundled", enabled: true })
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

  it("returns references/providers/fal.md as a nested supportingFile and mirrors it end to end", async () => {
    const loaded = await loadEnabledSkills();
    expect(loaded.map((s) => s.name)).toEqual(["demo"]);
    const refs = loaded[0].supportingFiles.map((f) => f.relPath);
    expect(refs).toContain(path.join("references", "providers", "fal.md"));

    await writeSkillsToWorkspace(workspace, loaded);
    for (const dialect of [".claude/skills", ".agents/skills"]) {
      const fal = path.join(workspace, dialect, "demo", "references", "providers", "fal.md");
      expect(fs.readFileSync(fal, "utf-8"), `${dialect}: fal.md`).toBe("FAL REFERENCE BODY");
      expect(fs.existsSync(path.join(workspace, dialect, "_shared"))).toBe(false);
    }
  });
});

describe("_shared is a source-of-truth folder, never a bundled skill", () => {
  it("no BUNDLED_SKILLS entry names an underscore-prefixed folder", () => {
    const underscored = BUNDLED_SKILLS.filter((s) => s.id.startsWith("_") || s.name.startsWith("_"));
    expect(underscored).toEqual([]);
  });
});
