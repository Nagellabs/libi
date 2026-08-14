import { describe, expect, it } from "vitest";
import { recommendModel } from "@/mcp/dev/fake-fal/kb";

/**
 * The fake-fal `recommend_model` must MIRROR real fal, not an idealized fal.
 *
 * Real fal's recommend/search surface pushes the trendy photoreal image model
 * (`fal-ai/nano-banana-2`) for UGC-creator-portrait intents — which is exactly
 * why `ai-asset-generation` Step 6.5 hard-pins `openai/gpt-image-2` and tells the
 * agent NOT to let `recommend_model` downgrade it.
 *
 * The old fake hard-defaulted `recommend_model` to `openai/gpt-image-2`. That made
 * the skill-eval assertion `{ gpt-image-2 present, nano-banana absent }` a tautology:
 * an agent that OBEYS the skill and one that BLINDLY TRUSTS recommend_model both
 * landed on gpt-image-2, so the test could never catch the violation that actually
 * happened in real mode. These tests lock in the adversarial behavior so the
 * assertion has teeth: only an agent that OVERRIDES the recommendation passes.
 */
describe("fake-fal recommendModel (adversarial mirror of real fal)", () => {
  it("recommends nano-banana-2 (NOT gpt-image-2) for a UGC creator portrait", () => {
    const r = recommendModel(
      "photorealistic UGC creator portrait, 9:16, realistic skin and hands",
      null,
    );
    expect(r.endpoint_id).toBe("fal-ai/nano-banana-2");
    expect(r.endpoint_id).not.toBe("openai/gpt-image-2");
  });

  it("recommends nano-banana-2 for a generic realism still / keyframe", () => {
    expect(recommendModel("a realistic photo keyframe of a product on a desk", null).endpoint_id).toBe(
      "fal-ai/nano-banana-2",
    );
  });

  it("still recommends a Seedance video endpoint for motion intents", () => {
    expect(recommendModel("photorealistic talking-head video, 9:16, 6 seconds", null).endpoint_id).toBe(
      "bytedance/seedance-2.0/image-to-video",
    );
  });

  it("lets a scenario byTaskMatch override win (escape hatch preserved)", () => {
    const r = recommendModel("portrait of a creator", {
      recommend_model: { byTaskMatch: [{ contains: "portrait", endpoint_id: "openai/gpt-image-2" }] },
    });
    expect(r.endpoint_id).toBe("openai/gpt-image-2");
  });

  it("lets a scenario default override win for non-video tasks", () => {
    const r = recommendModel("a realistic still", {
      recommend_model: { default: "fal-ai/flux-2-pro" },
    });
    expect(r.endpoint_id).toBe("fal-ai/flux-2-pro");
  });
});
