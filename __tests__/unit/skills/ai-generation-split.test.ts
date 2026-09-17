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
    // Craft stays in the body.
    expect(body).toContain("UGC selfie template");
    expect(body).toMatch(/prompt[- ]plausibility/i);
    expect(body).toMatch(/never let a recommendation tool downgrade/i);
    // Provider specifics do NOT.
    expect(body).not.toContain("openai/gpt-image-2");
    expect(body).not.toContain("fal-ai/nano-banana-2");
    expect(body).not.toContain("recommend_model");
  });

  it("the fal reference names gpt-image-2 as the realism default", () => {
    const ref = fs.readFileSync(
      path.join(getBundledSkillsDir(), "realistic-image-generation/references/providers/fal.md"),
      "utf-8",
    );
    expect(ref).toContain("openai/gpt-image-2");
    expect(ref).toMatch(/recommend_model[\s\S]{0,60}downgrade/i); // the "don't let it downgrade" rule
    expect(ref).toContain("fal-ai/nano-banana-2");
    expect(ref).toContain("openai/gpt-image-2/edit");
  });

  it("physical-action-video owns the manipulation / FLF craft", () => {
    const { frontmatter, body } = readSkill("physical-action-video");
    expect(frontmatter.name).toBe("physical-action-video");
    expect(frontmatter.description).toMatch(/physical|manipulation|FLF|first-last-frame/i);
    expect(body).toContain("first-last-frame");
    expect(body).toMatch(/decompos/i);
    expect(body).toMatch(/model-escalation ladder/i);
    // The ladder SHAPE + its cost rules stay in the body.
    expect(body).toMatch(/escalate only the failing beat/i);
    expect(body).toMatch(/start at the\s+strong model/i);
    expect(body).toMatch(/Disclose the higher per-second cost/);
    expect(body).toContain("references/providers/<id>.md");
    // Provider ids and tools moved out.
    expect(body).not.toContain("fal-ai/veo3.1");
    expect(body).not.toContain("fal-ai/kling-video");
    expect(body).not.toContain("bytedance/seedance-2.0");
    expect(body).not.toContain("get_pricing");
    expect(body).not.toContain("recommend_model");
    expect(body).not.toContain("fal-ai/video-understanding");
    expect(body).not.toMatch(/\b(fal-ai|bytedance|openai)\//);
  });

  it("physical-action-video's fal reference carries the ladder and the FLF shapes", () => {
    const ref = fs.readFileSync(
      path.join(getBundledSkillsDir(), "physical-action-video/references/providers/fal.md"),
      "utf-8",
    );
    expect(ref).toContain("fal-ai/veo3.1/fast/first-last-frame-to-video");
    expect(ref).toContain("fal-ai/kling-video/o1/image-to-video");
    expect(ref).toContain("end_image_url");
    expect(ref).toContain("fal-ai/wan-flf2v");
    expect(ref).toMatch(/Timestamp brackets DON'T work/i);
    // The moved hard rules, verbatim.
    expect(ref).toMatch(/dated examples \(2026-05\), NOT a fixed ranking/);
    expect(ref).toMatch(/never assume a hardcoded id is still best or even present/);
    expect(ref).toMatch(/`recommend_model` \/ `search_models` \/\s+`get_model_schema` \/ `get_pricing`/);
    expect(ref).toContain("fal-ai/video-understanding");
    expect(ref).toContain("verify via `get_pricing`");
    // Tier 1's second FLF surface and the Ceiling row survived only incidentally before —
    // a trim of the one tier carrying a live-availability caveat passed every guard.
    expect(ref).toMatch(/Kling 2\.5 Turbo also exposes start\/end/);
    expect(ref).toMatch(/\*\*Ceiling:\*\* Sora 2 Pro \(physics leader\)[\s\S]{0,120}sunset ~Sept 2026/);
    // Cross-references by path instead of re-listing the shared material.
    expect(ref).toMatch(/ai-video-models[\s\S]{0,80}references\/providers\/fal\.md/);
    expect(ref).toMatch(/ai-asset-generation[\s\S]{0,80}references\/providers\/fal\.md/);
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

/** Provider split: the fal tool names, endpoint ids, pricing steps and prompt
 *  templates live in `references/providers/fal.md`; the SKILL.md body keeps only the
 *  provider-agnostic mechanics and the universal invariants. This is the reference-file
 *  shape every later provider split follows. */
describe("ai-asset-generation provider split", () => {
  function readRef(skill: string, provider: string): string {
    return fs.readFileSync(
      path.join(getBundledSkillsDir(), skill, "references", "providers", `${provider}.md`),
      "utf-8",
    );
  }

  it("the fal specifics live in the reference, not the body", () => {
    const { body } = readSkill("ai-asset-generation");
    for (const falOnly of [
      "recommend_model",
      "get_pricing",
      "submit_job",
      "check_job",
      "run_model",
      "https://fal.ai/pricing",
      "fal-ai/veo3.1/fast",
    ]) {
      expect(body, `"${falOnly}" is still in the body`).not.toContain(falOnly);
    }
  });

  it("the body keeps the provider-agnostic mechanics", () => {
    const { body } = readSkill("ai-asset-generation");
    expect(body).toMatch(/no on-screen text/i); // universal invariant
    expect(body).toMatch(/generate_audio = true/); // universal invariant
    expect(body).toContain("libi.save_asset");
    expect(body).toContain("libi.upload_file");
    expect(body).toContain("aiGeneration");
    expect(body).toContain("libi.update_file_notes");
    expect(body).toContain("references/providers/");
  });

  it("the fal reference carries the moved text verbatim", () => {
    const ref = readRef("ai-asset-generation", "fal");
    expect(ref).toContain("`recommend_model`");
    expect(ref).toContain("`get_pricing`");
    expect(ref).toContain("bytedance/seedance-2.0/image-to-video");
    expect(ref).toContain("https://fal.ai/pricing");
    expect(ref).toContain("libi.sleep");
    expect(ref).toContain("openai/gpt-image-2");
  });
});
