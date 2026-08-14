import { describe, it, expect } from "vitest";
import { MODEL_KB, recommendModel, getSchema, getPricing } from "@/mcp/dev/fake-fal/kb";

describe("fake-fal model KB", () => {
  it("knows the key endpoints with a kind", () => {
    expect(MODEL_KB["openai/gpt-image-2"].kind).toBe("image");
    expect(MODEL_KB["fal-ai/nano-banana-2"].kind).toBe("image");
    expect(MODEL_KB["bytedance/seedance-2.0/image-to-video"].kind).toBe("video");
    expect(MODEL_KB["bytedance/seedance-2.0/reference-to-video"].kind).toBe("video");
  });

  it("knows the REAL Seedance 2.0 /fast/ endpoints (verified live-fal 2026-06-06)", () => {
    // The cheaper fast-tier variants are real fal endpoints (fal OpenAPI 200,
    // same input shape: generate_audio/end_image_url/duration). They must be in the
    // KB so falStrict doesn't 404 them and the skills↔KB audit doesn't flag a skill
    // that references them as drift. The result-fetch 404 the dogfood run hit (F8)
    // is a fal-client/MCP issue, not a "the endpoint doesn't exist" issue.
    expect(MODEL_KB["bytedance/seedance-2.0/fast/image-to-video"].kind).toBe("video");
    expect(MODEL_KB["bytedance/seedance-2.0/fast/reference-to-video"].kind).toBe("video");
    // fast tier is cheaper than standard
    expect(getPricing("bytedance/seedance-2.0/fast/image-to-video", null).amount)
      .toBeLessThan(getPricing("bytedance/seedance-2.0/image-to-video", null).amount);
  });

  it("fast i2v schema still exposes generate_audio + end_image_url (FLF)", () => {
    const s = getSchema("bytedance/seedance-2.0/fast/image-to-video", null);
    expect(s.properties.generate_audio).toBeDefined();
    expect(s.properties.end_image_url).toBeDefined();
  });

  it("seedance i2v schema exposes generate_audio (default true)", () => {
    const s = getSchema("bytedance/seedance-2.0/image-to-video", null);
    expect(s.properties.generate_audio).toBeDefined();
    expect(s.properties.generate_audio.default).toBe(true);
  });

  it("reference-to-video schema exposes image_urls + audio_urls", () => {
    const s = getSchema("bytedance/seedance-2.0/reference-to-video", null);
    expect(s.properties.image_urls).toBeDefined();
    expect(s.properties.audio_urls).toBeDefined();
  });

  it("default recommend_model picks nano-banana-2 for a portrait (adversarial mirror of real fal)", () => {
    // This deliberately returns the "wrong" model. Real fal's recommend/search surface
    // pushes fal-ai/nano-banana-2 for UGC portraits; ai-asset-generation Step 6.5 hard-pins
    // openai/gpt-image-2 precisely to OVERRIDE that. If this returned gpt-image-2, the
    // skill-eval assertion {gpt-image-2 present, nano-banana absent} would be a tautology
    // (it passes whether or not the agent obeys the pin — the real-mode F7 failure). See
    // __tests__/unit/fake-fal/recommend-model.test.ts for the full rationale.
    expect(recommendModel("photorealistic portrait reference image", null).endpoint_id)
      .toBe("fal-ai/nano-banana-2");
  });

  it("default recommend_model picks seedance i2v for a vertical video task", () => {
    expect(recommendModel("vertical UGC image-to-video with audio", null).endpoint_id)
      .toBe("bytedance/seedance-2.0/image-to-video");
  });

  it("scenario override flips the recommendation", () => {
    const cfg = { recommend_model: { byTaskMatch: [{ contains: "portrait", endpoint_id: "fal-ai/nano-banana-2" }] } };
    expect(recommendModel("a portrait image", cfg).endpoint_id).toBe("fal-ai/nano-banana-2");
  });

  it("getPricing returns a numeric amount per endpoint", () => {
    expect(typeof getPricing("openai/gpt-image-2", null).amount).toBe("number");
  });
});
