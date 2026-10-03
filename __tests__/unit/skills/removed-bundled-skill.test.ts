/**
 * A bundled skill removed from the registry (merged into another skill, or folded into the manual) leaves every
 * place libi put it on the next sync, and only those places: the DB row is dropped at seed, the loader no longer
 * returns it, and the writer removes its manifest-listed folder from libi's own agent roots and from a user's CLI
 * root it was mirrored to, never a folder the user made.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";
import { seedDatabase } from "@/lib/db/init";
import { getLibiAgentDir } from "@/lib/libi-home";
import { loadEnabledSkills } from "@/mcp/skills/loader";
import type { Skill } from "@/mcp/skills/types";
import { writeSkillsToRoot, writeSkillsToWorkspace } from "@/mcp/skills/writer";

const RETIRED = "retired-bundled-skill";
const SURVIVOR = "ai-asset-generation";

function skillOf(name: string): Skill {
  return {
    id: name,
    name,
    description: `${name} skill`,
    source: "bundled",
    enabled: true,
    body: `---\nname: ${name}\ndescription: ${name} skill\n---\n${name} body\n`,
    frontmatter: { name, description: `${name} skill` },
    supportingFiles: [{ relPath: "references/ref.md", contents: `${name} ref` }],
    tags: [],
  };
}

describe("a bundled skill removed from the registry", () => {
  let cwd: string;
  let home: string;
  let userRoot: string;
  let prevCwd: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevCwd = process.cwd();
    prevHome = process.env.LIBI_HOME;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "removed-skill-cwd-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "removed-skill-home-"));
    userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "removed-skill-user-"));
    // The bundle on disk has only the survivor; the retired skill's folder is gone with the release that removed it.
    const dir = path.join(cwd, "mcp", "skills", SURVIVOR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), skillOf(SURVIVOR).body);
    process.chdir(cwd);
    process.env.LIBI_HOME = home;
    createTestDb();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    resetTestDb();
    for (const d of [cwd, home, userRoot]) fs.rmSync(d, { recursive: true, force: true });
  });

  it("leaves libi's own agent roots and a mirrored user root on the next sync, and nothing the user made", async () => {
    const agentDir = getLibiAgentDir();
    // Last release: both skills were installed in both dialect roots and in the user's own CLI root, and the user
    // added a skill folder of their own beside libi's.
    await writeSkillsToWorkspace(agentDir, [skillOf(SURVIVOR), skillOf(RETIRED)]);
    writeSkillsToRoot(userRoot, [skillOf(SURVIVOR), skillOf(RETIRED)], { external: true });
    fs.mkdirSync(path.join(userRoot, "my-own-skill"));
    fs.writeFileSync(path.join(userRoot, "my-own-skill", "SKILL.md"), "mine");
    getDb().insert(skills).values({ id: RETIRED, name: RETIRED, description: "gone", source: "bundled", enabled: true }).run();
    expect(fs.existsSync(path.join(agentDir, ".claude/skills", RETIRED, "SKILL.md"))).toBe(true);

    // This release: boot seeds the DB, then the workspace and every install are synced from the enabled skills.
    seedDatabase(getDb() as never);
    expect(getDb().select().from(skills).all().map((r) => r.name)).not.toContain(RETIRED);
    const enabled = await loadEnabledSkills();
    expect(enabled.map((s) => s.name)).toEqual([SURVIVOR]);
    await writeSkillsToWorkspace(agentDir, enabled);
    writeSkillsToRoot(userRoot, enabled, { external: true });

    for (const dialect of [".claude/skills", ".agents/skills"]) {
      expect(fs.existsSync(path.join(agentDir, dialect, RETIRED)), `${dialect}/${RETIRED}`).toBe(false);
      expect(fs.existsSync(path.join(agentDir, dialect, SURVIVOR, "SKILL.md"))).toBe(true);
    }
    expect(fs.existsSync(path.join(userRoot, RETIRED))).toBe(false);
    expect(fs.existsSync(path.join(userRoot, SURVIVOR, "SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(userRoot, "my-own-skill", "SKILL.md"), "utf8")).toBe("mine");
  });

  it("never removes a same-named folder the user made in a CLI root libi did not write it to", () => {
    // The user's own folder that happens to carry the retired name is not in libi's manifest.
    fs.mkdirSync(path.join(userRoot, RETIRED));
    fs.writeFileSync(path.join(userRoot, RETIRED, "SKILL.md"), "the user's own");
    writeSkillsToRoot(userRoot, [skillOf(SURVIVOR)], { external: true });
    expect(fs.readFileSync(path.join(userRoot, RETIRED, "SKILL.md"), "utf8")).toBe("the user's own");
  });
});
