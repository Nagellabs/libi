import { describe, it, expect } from "vitest";
import { resolveEndpoint, kindFor, MODEL_KB, getSchema, getPricing } from "@/mcp/dev/fake-fal/kb";
import { buildCallRecord, strictReject } from "@/mcp/dev/fake-fal/tools";

describe("resolveEndpoint", () => {
  it("resolves an exact canonical id to itself", () => {
    expect(resolveEndpoint("openai/gpt-image-2", null)).toEqual({
      canonical: "openai/gpt-image-2",
      viaAlias: false,
    });
  });

  // No live-fal-verified KB-level aliases exist (see kb.ts `aliases` doc); the
  // supported remap path is per-scenario `aliasOverrides`, exercised below.
  it("resolves a per-scenario alias to its canonical video entry", () => {
    const r = resolveEndpoint("legacy/seedance-i2v", {
      aliasOverrides: { "legacy/seedance-i2v": "bytedance/seedance-2.0/image-to-video" },
    });
    expect(r.canonical).toBe("bytedance/seedance-2.0/image-to-video");
    expect(r.viaAlias).toBe(true);
  });

  it("returns null canonical for an unknown id", () => {
    expect(resolveEndpoint("fal-ai/totally-made-up", null)).toEqual({
      canonical: null,
      viaAlias: false,
    });
  });

  it("honors a per-scenario aliasOverride", () => {
    const r = resolveEndpoint("fal-ai/x/custom", { aliasOverrides: { "fal-ai/x/custom": "openai/gpt-image-2" } });
    expect(r).toEqual({ canonical: "openai/gpt-image-2", viaAlias: true });
  });

  it("kindFor returns the right media kind for a known video endpoint", () => {
    expect(kindFor("bytedance/seedance-2.0/image-to-video")).toBe("video");
  });

  // Regression (dogfood 2026-06-05): the agent legitimately reaches for seedance-2.0
  // text-to-video for from-scratch faceless b-roll (no start frame). It is a REAL
  // canonical fal endpoint (live-fal 200) and must resolve canonically — not be
  // false-flagged unknown (which would also false-404 under falStrict).
  it("resolves all three real seedance-2.0 operations as canonical (incl. text-to-video)", () => {
    for (const id of [
      "bytedance/seedance-2.0/text-to-video",
      "bytedance/seedance-2.0/image-to-video",
      "bytedance/seedance-2.0/reference-to-video",
    ]) {
      const r = resolveEndpoint(id, null);
      expect(r.canonical, `missing: ${id}`).toBe(id);
      expect(kindFor(id)).toBe("video");
    }
  });

  it("KB covers every skill-sanctioned endpoint string", () => {
    for (const id of [
      "openai/gpt-image-2/edit",
      "fal-ai/flux-pro/v1.1-ultra",
      "fal-ai/veo3.1/fast/image-to-video",
      "fal-ai/kling-video/o1/image-to-video",
      "fal-ai/wan-flf2v",
      "fal-ai/video-understanding",
      "fal-ai/flux/dev",
    ]) {
      expect(resolveEndpoint(id, null).canonical, `missing: ${id}`).not.toBeNull();
    }
  });
});

describe("getSchema/getPricing alias-awareness", () => {
  // Alias path is via per-scenario aliasOverrides (no live-verified KB aliases).
  const ALIAS_CFG = { aliasOverrides: { "legacy/seedance-i2v": "bytedance/seedance-2.0/image-to-video" } };

  it("getSchema returns the canonical entry's schema for an aliased id", () => {
    const viaAlias = getSchema("legacy/seedance-i2v", ALIAS_CFG);
    const viaCanonical = getSchema("bytedance/seedance-2.0/image-to-video", null);
    expect(viaAlias).toEqual(viaCanonical);
    // sanity: it's the seedance i2v schema (has image_url), not the generic prompt-only fallback
    expect(Object.keys(viaAlias.properties)).toContain("image_url");
  });

  it("getPricing returns the canonical entry's pricing for an aliased id", () => {
    const viaAlias = getPricing("legacy/seedance-i2v", ALIAS_CFG);
    expect(viaAlias).toEqual({ amount: 0.5, currency: "USD", unit: "clip" });
  });
});

describe("buildCallRecord", () => {
  it("adds canonical_endpoint_id for an aliased call, no unknown flag", () => {
    const rec = buildCallRecord("legacy/seedance-i2v", {
      aliasOverrides: { "legacy/seedance-i2v": "bytedance/seedance-2.0/image-to-video" },
    });
    expect(rec.canonical_endpoint_id).toBe("bytedance/seedance-2.0/image-to-video");
    expect(rec.unknown_endpoint).toBeUndefined();
  });

  it("flags an unknown endpoint", () => {
    const rec = buildCallRecord("fal-ai/made-up", null);
    expect(rec.unknown_endpoint).toBe(true);
    expect(rec.canonical_endpoint_id).toBeUndefined();
  });

  it("omits canonical when it equals the literal id (no noise)", () => {
    const rec = buildCallRecord("openai/gpt-image-2", null);
    expect(rec.canonical_endpoint_id).toBeUndefined();
    expect(rec.unknown_endpoint).toBeUndefined();
  });
});

describe("strictReject", () => {
  it("rejects unknown only when cfg.strict", () => {
    expect(strictReject("fal-ai/made-up", { strict: true })).toBe(true);
    expect(strictReject("fal-ai/made-up", { strict: false })).toBe(false);
    expect(strictReject("fal-ai/made-up", null)).toBe(false);
    expect(strictReject("openai/gpt-image-2", { strict: true })).toBe(false);
  });
});
