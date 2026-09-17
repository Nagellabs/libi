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

/**
 * One shared `VEO_SCHEMA` stood in for eight endpoints with eight
 * different input shapes. The visible cost: the dedicated FLF endpoint behind
 * `physical-action-video`'s headline technique advertised no way to pass a last
 * frame at all, so an agent that did the right thing — read the schema before
 * calling — concluded the technique was unavailable, and a scenario exercising
 * it would have failed for a reason unrelated to the skill.
 *
 * The follow-up asked for `end_image_url` on the Veo endpoint. fal's live
 * OpenAPI says otherwise (fetched 2026-09-09, per endpoint via
 * https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>): Veo FLF takes
 * `first_frame_url` + `last_frame_url`, both REQUIRED. `end_image_url` is
 * Seedance's i2v spelling and Kling/Wan's start/end spelling — three different
 * conventions, which is exactly why the skills now tell the agent to read the
 * schema rather than assume one.
 */
describe("FLF-capable endpoints expose a real last-frame parameter", () => {
  it("veo3.1 FLF takes first_frame_url + last_frame_url, both required", () => {
    const s = getSchema("fal-ai/veo3.1/fast/first-last-frame-to-video", null);
    expect(s.properties.first_frame_url).toBeDefined();
    expect(s.properties.last_frame_url).toBeDefined();
    expect(s.required).toEqual(
      expect.arrayContaining(["prompt", "first_frame_url", "last_frame_url"]),
    );
    // Guard against reintroducing the Seedance spelling on this endpoint: it is
    // the specific wrong guess the follow-up itself made.
    expect(s.properties.end_image_url).toBeUndefined();
    expect(s.properties.image_url).toBeUndefined();
  });

  it("wan-flf2v takes start_image_url + end_image_url, both required", () => {
    const s = getSchema("fal-ai/wan-flf2v", null);
    expect(s.required).toEqual(
      expect.arrayContaining(["prompt", "start_image_url", "end_image_url"]),
    );
  });

  it("kling o1 takes start_image_url + an optional end_image_url", () => {
    const s = getSchema("fal-ai/kling-video/o1/image-to-video", null);
    expect(s.properties.start_image_url).toBeDefined();
    expect(s.properties.end_image_url).toBeDefined();
    expect(s.required).toEqual(["prompt", "start_image_url"]);
  });

  it("gives the three veo3.1 operations their three different required inputs", () => {
    expect(getSchema("fal-ai/veo3.1/fast/image-to-video", null).required).toEqual([
      "prompt",
      "image_url",
    ]);
    expect(getSchema("fal-ai/veo3.1/fast/extend-video", null).required).toEqual([
      "prompt",
      "video_url",
    ]);
    // video-understanding is an analysis endpoint, not a generator, and was
    // wearing the Veo shape too.
    expect(getSchema("fal-ai/video-understanding", null).required).toEqual([
      "video_url",
      "prompt",
    ]);
  });
});
