import { describe, it, expect } from "vitest";
import { resolveEndpoint, kindFor, getSchema, MODEL_KB } from "@/mcp/dev/fake-fal/kb";

describe("background-removal KB entries", () => {
  it("bria video background-removal is a known video endpoint taking video_url", () => {
    expect(resolveEndpoint("bria/video/background-removal", null)).toEqual({
      canonical: "bria/video/background-removal",
      viaAlias: false,
    });
    expect(kindFor("bria/video/background-removal")).toBe("video");
    const schema = getSchema("bria/video/background-removal", null);
    expect(schema.required).toContain("video_url");
  });

  it("birefnet is a known image endpoint taking image_url", () => {
    expect(resolveEndpoint("fal-ai/birefnet", null).canonical).toBe("fal-ai/birefnet");
    expect(kindFor("fal-ai/birefnet")).toBe("image");
    const schema = getSchema("fal-ai/birefnet", null);
    expect(schema.required).toContain("image_url");
  });

  it("both entries carry pricing (the skill's cost-disclosure source)", () => {
    expect(MODEL_KB["bria/video/background-removal"].pricing.amount).toBeGreaterThan(0);
    expect(MODEL_KB["fal-ai/birefnet"].pricing.amount).toBeGreaterThan(0);
  });
});
