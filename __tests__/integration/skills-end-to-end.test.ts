import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { addSkill, listSkills, setSkillEnabled } from "@/mcp/tools/skill-tools";
import { loadEnabledSkills } from "@/mcp/skills/loader";
import { writeSkillsToWorkspace } from "@/mcp/skills/writer";

describe("skills end-to-end", () => {
  let homeRoot: string;
  let workspace: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skills-e2e-home-"));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "skills-e2e-ws-"));
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = homeRoot;
    createTestDb();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    resetTestDb();
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("install + load + write puts a user skill in both dialect workspace surfaces", async () => {
    await addSkill({} as never, {
      name: "demo",
      description: "demo skill",
      body: `---\nname: demo\ndescription: demo skill\n---\nDemo body.\n`,
    });
    const list = await loadEnabledSkills();
    expect(list.find((s) => s.name === "demo")?.source).toBe("user");
    await writeSkillsToWorkspace(workspace, list);
    expect(
      fs.readFileSync(path.join(workspace, ".claude/skills/demo/SKILL.md"), "utf-8"),
    ).toContain("Demo body.");
    expect(
      fs.readFileSync(path.join(workspace, ".agents/skills/demo/SKILL.md"), "utf-8"),
    ).toContain("Demo body.");
    expect(fs.existsSync(path.join(workspace, "GEMINI.md"))).toBe(false);
  });

  it("toggle off via setSkillEnabled removes the skill from workspace on next write", async () => {
    await addSkill({} as never, {
      name: "demo",
      description: "demo skill",
      body: `---\nname: demo\ndescription: demo skill\n---\nDemo body.\n`,
    });
    const list1 = JSON.parse((await listSkills({} as never, {})).content[0].text);
    const id = list1.skills.find((s: { name: string; id: string }) => s.name === "demo").id;

    await writeSkillsToWorkspace(workspace, await loadEnabledSkills());
    expect(fs.existsSync(path.join(workspace, ".claude/skills/demo/SKILL.md"))).toBe(true);

    await setSkillEnabled({} as never, { id, enabled: false });
    await writeSkillsToWorkspace(workspace, await loadEnabledSkills());
    expect(fs.existsSync(path.join(workspace, ".claude/skills/demo"))).toBe(false);
  });
});
