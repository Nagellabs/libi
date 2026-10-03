/**
 * A user copy of a skill (a fork, or one the user wrote) is a frozen snapshot. One made before the bundled
 * skills were consolidated still tells the agent to load skills that no longer exist, and the user copy wins
 * the lookup for its own name. libi cannot rewrite the copy, so it says so: `libi.skill` list flags the
 * copy with `retiredSkillRefs`, and the manual maps each retired name to its successor.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";
import { listSkills } from "@/mcp/tools/skill-tools";
import { RETIRED_SKILLS, findRetiredSkillRefs } from "@/mcp/skills/retired";
import { MCP_DIR, skillIds } from "@/__tests__/helpers/skill-graph";

describe("RETIRED_SKILLS", () => {
  it("names no skill that still ships, and every successor ships", () => {
    const shipped = new Set(skillIds());
    for (const [name, { successor }] of Object.entries(RETIRED_SKILLS)) {
      expect(shipped.has(name), `${name} is retired but its folder still exists`).toBe(false);
      if (successor) expect(shipped.has(successor), `${name} -> ${successor} does not exist`).toBe(true);
    }
  });

  it("is mapped in the manual, so an agent that meets a retired name knows where it went", () => {
    const manual = fs.readFileSync(path.join(MCP_DIR, "templates", "instructions.md"), "utf8");
    for (const [name, { successor }] of Object.entries(RETIRED_SKILLS)) {
      expect(manual, `the manual does not map retired skill ${name}`).toContain(`\`${name}\``);
      if (successor) expect(manual).toContain(`\`${successor}\``);
    }
  });
});

describe("findRetiredSkillRefs", () => {
  it("finds a retired skill named in a body, with its successor", () => {
    const refs = findRetiredSkillRefs("Load `ugc-craft` and the using-asset-folders skill first.");
    expect(refs).toEqual([
      { name: "ugc-craft", successor: "ugc-product-video" },
      { name: "using-asset-folders", successor: null },
    ]);
  });

  it("matches whole names only", () => {
    expect(findRetiredSkillRefs("my-ugc-craft and ugc-craft-2 are other things")).toEqual([]);
  });

  it("finds nothing in a body that names only live skills, or in no body", () => {
    expect(findRetiredSkillRefs("Load `video-generation-craft`.")).toEqual([]);
    expect(findRetiredSkillRefs(null)).toEqual([]);
  });
});

describe("libi.skill list flags an outdated user copy", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "retired-skills-"));
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = home;
    createTestDb();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    resetTestDb();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const row = (name: string, source: "bundled" | "user", body: string) =>
    getDb()
      .insert(skills)
      .values({ id: `${source}-${name}`, name, description: "d", source, enabled: true, body })
      .run();

  it("adds retiredSkillRefs to a user copy that names a retired skill and leaves the rest alone", async () => {
    row("ugc-product-video", "bundled", "");
    row("ugc-product-video", "user", "---\nname: ugc-product-video\ndescription: d\n---\nLoad ugc-craft, then ai-video-models.");
    row("clean-copy", "user", "---\nname: clean-copy\ndescription: d\n---\nLoad video-generation-craft.");
    const data = JSON.parse((await listSkills({} as never, {})).content[0].text) as {
      skills: { name: string; source: string; retiredSkillRefs?: unknown }[];
    };
    const fork = data.skills.find((s) => s.name === "ugc-product-video" && s.source === "user");
    expect(fork?.retiredSkillRefs).toEqual([
      { name: "ai-video-models", successor: "video-generation-craft" },
      { name: "ugc-craft", successor: "ugc-product-video" },
    ]);
    expect(data.skills.find((s) => s.name === "clean-copy")).not.toHaveProperty("retiredSkillRefs");
    expect(data.skills.find((s) => s.source === "bundled")).not.toHaveProperty("retiredSkillRefs");
  });
});
