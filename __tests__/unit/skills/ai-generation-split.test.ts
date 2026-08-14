import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseSkillBody } from "@/mcp/skills/frontmatter";
import { getBundledSkillsDir } from "@/lib/libi-home";

/** Content guard for the ai-asset-generation split: the produce-one-asset mechanics +
 *  universal invariants stay in ai-asset-generation; the realism-image craft and the
 *  physical-action/FLF craft live in their own skills. A future edit that re-merges them
 *  (or drops the universal invariants) fails here. */

function readSkill(name: string): { frontmatter: ReturnType<typeof parseSkillBody>["frontmatter"]; body: string } {
  const raw = fs.readFileSync(path.join(getBundledSkillsDir(), name, "SKILL.md"), "utf-8");
  return parseSkillBody(raw);
}

describe("ai-asset-generation split", () => {
  it("realistic-image-generation owns the image-realism craft", () => {
    const { frontmatter, body } = readSkill("realistic-image-generation");
    expect(frontmatter.name).toBe("realistic-image-generation");
    expect(frontmatter.description).toMatch(/realistic|keyframe|gpt-image-2/i);
    expect(body).toContain("openai/gpt-image-2");
    expect(body).toMatch(/recommend_model.{0,40}downgrade/i); // the "don't let it downgrade" rule
    expect(body).toContain("UGC selfie template");
    expect(body).toMatch(/prompt[- ]plausibility/i);
  });

  it("physical-action-video owns the manipulation / FLF craft", () => {
    const { frontmatter, body } = readSkill("physical-action-video");
    expect(frontmatter.name).toBe("physical-action-video");
    expect(frontmatter.description).toMatch(/physical|manipulation|FLF|first-last-frame/i);
    expect(body).toContain("first-last-frame");
    expect(body).toMatch(/decompos/i);
    expect(body).toMatch(/model-escalation ladder/i);
  });

  it("ai-asset-generation keeps the universal invariants and points at the craft skills", () => {
    const { body } = readSkill("ai-asset-generation");
    // Universal video invariants stay here.
    expect(body).toMatch(/no on-screen text/i);
    expect(body).toMatch(/generate_audio = true/);
    // Pointers to the extracted craft skills.
    expect(body).toContain("realistic-image-generation");
    expect(body).toContain("physical-action-video");
    // The craft itself moved OUT — the gpt-image-2 picker block + FLF ladder no longer live here.
    expect(body).not.toContain("### Model picker (image gen for realism)");
    expect(body).not.toContain("### A) Default to first-last-frame (FLF), not text-to-video");
  });
});
