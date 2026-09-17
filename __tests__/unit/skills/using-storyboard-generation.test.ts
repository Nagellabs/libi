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


/** Reads a file under the bundled skills dir by skill-relative path. */
function read(rel: string): string {
  return fs.readFileSync(path.join(getBundledSkillsDir(), rel), "utf-8");
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

  it("the storyboard body names no provider endpoint", () => {
    const md = read("using-storyboard/SKILL.md");
    expect(md).toContain("libi.get_model_schema_cache");
    expect(md).toContain("libi.set_storyboard_generation");
    expect(md).not.toContain("openai/gpt-image-2");
    expect(md).not.toContain("Seedance image-to-video");
    expect(md).not.toMatch(/fal's `get_model_schema`/);
    // One place for endpoint ids: no vendor-prefixed id survives in the body.
    expect(md).not.toMatch(/\b(fal-ai|bytedance|openai)\//);
    // The body still points at the provider reference at each moved step.
    expect(md).toMatch(/hosting MCP's own\s+schema tool[\s\S]{0,120}references\/providers\/<id>\.md/);
    expect(md).toMatch(/masked-edit \/\s+composition-reference[\s\S]{0,200}references\/providers\/<id>\.md/);
    expect(md).toMatch(/your video model's\s+image-to-video endpoint/);
  });

  it("the fal reference explains cache population and the keyframe edit endpoint", () => {
    const ref = read("using-storyboard/references/providers/fal.md");
    expect(ref).toContain("get_model_schema");
    expect(ref).toContain("openai/gpt-image-2/edit");
    expect(ref).toContain("GenFieldDef");
    // The moved rules, verbatim: the normalize step, the endpoint ids the examples use,
    // and the cross-references to the sibling references by path.
    expect(ref).toContain("libi.save_model_schema_cache({ apiUrl, model, fields, source? })");
    // Cache-key stability: a drifting apiUrl silently misses the cache and re-trips the
    // schema_cache_missing gate. Operational rule, so it gets its own pin.
    expect(ref).toMatch(/`apiUrl: "https:\/\/fal\.run"`[\s\S]{0,120}cache key\s+is stable across sessions/);
    expect(ref).toContain("loose composition reference");
    expect(ref).toContain("bytedance/seedance-2.0/image-to-video");
    expect(ref).toContain("bytedance/seedance-2.0/reference-to-video");
    expect(ref).toContain("end_image_url");
    expect(ref).toMatch(/realistic-image-generation[\s\S]{0,80}references\/providers\/fal\.md/);
    expect(ref).toMatch(/ai-video-models[\s\S]{0,80}references\/providers\/fal\.md/);
    expect(ref).toMatch(/ai-asset-generation[\s\S]{0,120}references\/providers\/fal\.md/);
  });
});
