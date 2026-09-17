import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import {
  listSkills,
  addSkill,
  removeSkill,
  setSkillEnabled,
} from "@/mcp/tools/skill-tools";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";

const VALID_BODY = `---\nname: my-skill\ndescription: Mine\n---\nBody.\n`;

describe("skill tools", () => {
  let homeRoot: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
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

  it("add_skill writes DB row + file under ~/.libi/skills", async () => {
    const res = await addSkill({} as never, {
      name: "my-skill",
      description: "Mine",
      body: VALID_BODY,
    });
    expect(res.error).toBeUndefined();
    const onDisk = fs.readFileSync(
      path.join(homeRoot, "skills/my-skill/SKILL.md"),
      "utf-8",
    );
    expect(onDisk).toContain("Body.");
  });

  it("add_skill rejects when frontmatter name does not match params.name", async () => {
    const res = await addSkill({} as never, {
      name: "different",
      description: "x",
      body: VALID_BODY,
    });
    expect(res.error).toMatch(/name/i);
  });

  it("list_skills returns the new row", async () => {
    await addSkill({} as never, {
      name: "my-skill",
      description: "Mine",
      body: VALID_BODY,
    });
    const list = await listSkills({} as never, {});
    const data = JSON.parse((list.content[0] as { text: string }).text);
    expect(data.skills.find((s: { name: string }) => s.name === "my-skill")).toBeDefined();
  });

  it("set_skill_enabled toggles state", async () => {
    await addSkill({} as never, {
      name: "my-skill",
      description: "Mine",
      body: VALID_BODY,
    });
    const list1 = JSON.parse(
      (await listSkills({} as never, {})).content[0].text,
    );
    const id = list1.skills.find(
      (s: { name: string; id: string }) => s.name === "my-skill",
    ).id;
    await setSkillEnabled({} as never, { id, enabled: false });
    const list2 = JSON.parse(
      (await listSkills({} as never, {})).content[0].text,
    );
    expect(
      list2.skills.find((s: { name: string; enabled: boolean }) => s.name === "my-skill")
        .enabled,
    ).toBe(false);
  });

  it("remove_skill blocks bundled skills", async () => {
    getDb()
      .insert(skills)
      .values({
        id: "bundled",
        name: "bundled-x",
        description: "x",
        source: "bundled",
        enabled: true,
      })
      .run();
    const res = await removeSkill({} as never, { id: "bundled" });
    expect(res.error).toMatch(/bundled/i);
  });

});
