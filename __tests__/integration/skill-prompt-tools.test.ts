import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { addSkill, listSkillPrompts, addSkillPrompt, updateSkillPrompt, removeSkillPrompt } from "@/mcp/tools/skill-tools";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";

const DEMO_BODY = `---\nname: demo\ndescription: d\n---\nUse prompts/hook.md\n`;

describe("skill prompt-file tools", () => {
  let homeRoot: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-prompt-tools-"));
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = homeRoot;
    createTestDb();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    resetTestDb();
    fs.rmSync(homeRoot, { recursive: true, force: true });
  });

  it("add_skill_prompt writes a prompt file to disk", async () => {
    // 1. Create user skill
    await addSkill({} as never, { name: "demo", description: "d", body: DEMO_BODY });

    // 2. Add a prompt file
    const res = await addSkillPrompt({} as never, { skillName: "demo", name: "hook", body: "# Hook" });
    expect(res.error).toBeUndefined();

    // 4. Assert file exists on disk
    const diskPath = path.join(homeRoot, "skills/demo/prompts/hook.md");
    expect(fs.existsSync(diskPath)).toBe(true);
    expect(fs.readFileSync(diskPath, "utf-8")).toBe("# Hook");
  });

  it("list_skill_prompts returns the added prompt", async () => {
    await addSkill({} as never, { name: "demo", description: "d", body: DEMO_BODY });
    await addSkillPrompt({} as never, { skillName: "demo", name: "hook", body: "# Hook" });

    // 3. List returns the prompt
    const list = await listSkillPrompts({} as never, { skillName: "demo" });
    const data = JSON.parse(list.content[0].text);
    expect(data.prompts).toEqual([{ relPath: "prompts/hook.md", body: "# Hook" }]);
  });

  it("remove_skill_prompt removes the file, list returns []", async () => {
    await addSkill({} as never, { name: "demo", description: "d", body: DEMO_BODY });
    await addSkillPrompt({} as never, { skillName: "demo", name: "hook", body: "# Hook" });

    // 5. Remove then list returns []
    const rmRes = await removeSkillPrompt({} as never, { skillName: "demo", name: "hook" });
    expect(rmRes.error).toBeUndefined();

    const list = await listSkillPrompts({} as never, { skillName: "demo" });
    const data = JSON.parse(list.content[0].text);
    expect(data.prompts).toEqual([]);
  });

  it("update_skill_prompt updates the file contents", async () => {
    await addSkill({} as never, { name: "demo", description: "d", body: DEMO_BODY });
    await addSkillPrompt({} as never, { skillName: "demo", name: "hook", body: "# Hook v1" });
    const res = await updateSkillPrompt({} as never, { skillName: "demo", name: "hook", body: "# Hook v2" });
    expect(res.error).toBeUndefined();

    const list = await listSkillPrompts({} as never, { skillName: "demo" });
    const data = JSON.parse(list.content[0].text);
    expect(data.prompts).toEqual([{ relPath: "prompts/hook.md", body: "# Hook v2" }]);
  });

  it("add_skill_prompt rejects a bundled skill (non-user skill returns error)", async () => {
    // Insert a bundled row directly
    getDb()
      .insert(skills)
      .values({
        id: "bundled-test",
        name: "ai-asset-generation",
        description: "bundled",
        source: "bundled",
        enabled: true,
      })
      .run();

    // 6. Adding to a bundled skill should return an error
    const res = await addSkillPrompt({} as never, { skillName: "ai-asset-generation", name: "x", body: "y" });
    const data = JSON.parse(res.content[0].text);
    expect(data.error).toBeTruthy();
  });

  it("add_skill_prompt rejects duplicate prompt name", async () => {
    await addSkill({} as never, { name: "demo", description: "d", body: DEMO_BODY });
    await addSkillPrompt({} as never, { skillName: "demo", name: "hook", body: "# First" });

    const res = await addSkillPrompt({} as never, { skillName: "demo", name: "hook", body: "# Second" });
    const data = JSON.parse(res.content[0].text);
    expect(data.error).toMatch(/already exists/i);
  });

  it("update_skill_prompt rejects non-existent prompt", async () => {
    await addSkill({} as never, { name: "demo", description: "d", body: DEMO_BODY });

    const res = await updateSkillPrompt({} as never, { skillName: "demo", name: "nonexistent", body: "x" });
    const data = JSON.parse(res.content[0].text);
    expect(data.error).toMatch(/does not exist/i);
  });

  it("remove_skill_prompt rejects path-traversal name and does not delete outside the skill folder", async () => {
    await addSkill({} as never, { name: "demo", description: "d", body: DEMO_BODY });
    // Create a canary file outside the skill prompts dir to ensure it's not deleted
    const canaryDir = path.join(homeRoot, "skills", "other-skill");
    fs.mkdirSync(canaryDir, { recursive: true });
    fs.writeFileSync(path.join(canaryDir, "SKILL.md"), "canary");

    const res = await removeSkillPrompt({} as never, { skillName: "demo", name: "../../x" });
    const data = JSON.parse(res.content[0].text);
    expect(data.error).toBeTruthy();
    // Canary must still exist
    expect(fs.existsSync(path.join(canaryDir, "SKILL.md"))).toBe(true);
  });
});
