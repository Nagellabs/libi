import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getSchema } from "@/mcp/dev/fake-fal/kb";

/**
 * The first-last-frame keyframe fields differ per engine, and the skills used
 * to name them wrong in a way nothing could catch.
 *
 * `physical-action-video`'s ladder told the agent Kling's FLF inputs were
 * `@Image1` / `@Image2`. Those are Kling's prompt-REFERENCE tokens on other
 * endpoints; `fal-ai/kling-video/o1/image-to-video` takes `start_image_url` /
 * `end_image_url` (fal live OpenAPI, 2026-09-09). And the Tier-0 default —
 * Veo's dedicated FLF endpoint — had its field names stated nowhere at all,
 * while the fake's schema for it carried no last-frame input, so neither the
 * documentation nor the test harness could have corrected the agent.
 *
 * This pins the references to the same names the KB serves, so the two can
 * only drift together. It is a NAMES check, not a prose check: it says nothing
 * about the craft advice around them.
 */
const SKILLS = path.join(process.cwd(), "mcp", "skills");

function reference(skill: string): string {
  return fs.readFileSync(
    path.join(SKILLS, skill, "references", "providers", "fal.md"),
    "utf-8",
  );
}

describe("FLF provider references name the fields fal actually takes", () => {
  const refs = [
    ["physical-action-video", reference("physical-action-video")],
    ["ai-video-models", reference("ai-video-models")],
  ] as const;

  for (const [skill, md] of refs) {
    it(`${skill} names Kling o1's real start/end fields, not @Image1/@Image2`, () => {
      const kling = getSchema("fal-ai/kling-video/o1/image-to-video", null);
      expect(Object.keys(kling.properties)).toEqual(
        expect.arrayContaining(["start_image_url", "end_image_url"]),
      );
      expect(md).toContain("start_image_url");
      // The claim that sent agents to a non-existent input shape.
      expect(md).not.toMatch(/@Image1[^)]*=?\s*start|start\s*=\s*`?@Image1/);
      expect(md).not.toContain("@Image2");
    });

    it(`${skill} names Veo FLF's real first/last frame fields`, () => {
      const veo = getSchema("fal-ai/veo3.1/fast/first-last-frame-to-video", null);
      expect(veo.required).toEqual(
        expect.arrayContaining(["first_frame_url", "last_frame_url"]),
      );
      expect(md).toContain("first_frame_url");
      expect(md).toContain("last_frame_url");
    });

    it(`${skill} still warns that the field names are per-engine`, () => {
      // The generic "look for an end_image_url" advice is fine and stays —
      // what must survive is the sentence saying it is NOT universal, because
      // that is the instruction that makes the agent read the schema.
      expect(md).toMatch(/differ per engine|there is no universal `end_image_url`/i);
      expect(md).toMatch(/get_model_schema/);
    });
  }
});
