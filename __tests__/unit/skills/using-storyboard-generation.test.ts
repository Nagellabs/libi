import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseSkillBody } from "@/mcp/skills/frontmatter";
import { getBundledSkillsDir } from "@/lib/libi-home";

/** Content guard: the using-storyboard skill must keep teaching the generation-spec +
 *  schema-cache workflow (M3). A future edit that silently drops it fails here, so the
 *  storyboard skill can't regress to the prompt-only / rigid-ladder model. */
const SKILL_NAME = "using-storyboard";

function readSkill(): { frontmatter: ReturnType<typeof parseSkillBody>["frontmatter"]; body: string } {
  const raw = fs.readFileSync(path.join(getBundledSkillsDir(), SKILL_NAME, "SKILL.md"), "utf-8");
  return parseSkillBody(raw);
}

describe("using-storyboard skill — generation spec teaching", () => {
  it("frontmatter advertises the generation spec + schema cache", () => {
    const { frontmatter } = readSkill();
    expect(frontmatter.name).toBe(SKILL_NAME);
    expect(frontmatter.description).toMatch(/generation spec|schema[- ]cache|model-schema/i);
  });

  it("teaches the schema-cache workflow tools", () => {
    const { body } = readSkill();
    for (const tool of [
      "get_model_schema_cache",
      "save_model_schema_cache",
      "invalidate_model_schema_cache",
      "set_storyboard_generation",
      "set_storyboard_reference",
      "select_storyboard_take",
    ]) {
      expect(body, `SKILL.md should teach ${tool}`).toContain(tool);
    }
  });

  it("teaches the keyframing + continuity-reference idea space + defaults", () => {
    const { body } = readSkill();
    for (const token of ["start_frame", "end_frame", "reference_video", "GenFieldDef"]) {
      expect(body, `SKILL.md should mention ${token}`).toContain(token);
    }
    // The "every card carries a generation spec" default must survive edits.
    expect(body).toMatch(/every card.{0,40}generation spec/i);
    // The cache gate must be documented (refuses until populated).
    expect(body).toMatch(/schema_cache_missing|cache.{0,20}populate/i);
  });
});
