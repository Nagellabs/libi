import { describe, it, expect } from "vitest";
import {
  aiGenerationMetaSchema,
  parseAiGenerationMeta,
  serializeAiGenerationMeta,
  type AiGenerationMeta,
} from "@/lib/ai-generation/types";
import { PROVIDER_IDS, isProviderId, normalizeProviderId } from "@/lib/providers/catalog";

/**
 * The provenance `provider` field was free-form `z.string()`: nothing
 * connected it to the catalog, and the fake fal and a skill had already
 * disagreed over `fal` vs `fal-ai` — two spellings of one provider, which is
 * the whole failure mode.
 *
 * The resolution is NORMALISE, not enumerate. See the field's comment in
 * `lib/ai-generation/types.ts` for why a `z.enum(PROVIDER_IDS)` would be worse
 * than the problem: `parseAiGenerationMeta` returns null on a parse failure, so
 * a closed enum blanks a legacy row's entire Generation tab, and libi no longer
 * owns the list of providers a user's own agent can have.
 */

const BASE = {
  model: "veo3.1-fast",
  prompt: "a cat",
  startedAt: "2026-09-09T00:00:00.000Z",
  completedAt: "2026-09-09T00:00:20.000Z",
  durationMs: 20_000,
};

describe("provenance provider ids", () => {
  it("derives the id list from the catalog itself", () => {
    expect(PROVIDER_IDS).toContain("fal");
    expect(PROVIDER_IDS).toContain("kokoro");
    expect(new Set(PROVIDER_IDS).size).toBe(PROVIDER_IDS.length);
    expect(isProviderId("fal")).toBe(true);
    expect(isProviderId("fal-ai")).toBe(false);
    expect(isProviderId(42)).toBe(false);
  });

  it("maps every legacy bundled-MCP spelling forward to its catalog id", () => {
    expect(normalizeProviderId("fal-ai")).toBe("fal");
    expect(normalizeProviderId("local-tts")).toBe("kokoro");
    expect(normalizeProviderId("local-music")).toBe("ace-step");
    // Already-current ids and non-strings pass through untouched.
    expect(normalizeProviderId("fal")).toBe("fal");
    expect(normalizeProviderId("elevenlabs")).toBe("elevenlabs");
    expect(normalizeProviderId(undefined)).toBeUndefined();
    for (const id of PROVIDER_IDS) expect(normalizeProviderId(id)).toBe(id);
  });

  it("normalises on WRITE, so the two spellings cannot both land in the column", () => {
    const raw = serializeAiGenerationMeta({
      ...BASE,
      provider: "fal-ai",
    } as unknown as AiGenerationMeta);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).provider).toBe("fal");
  });

  it("normalises on READ, so a row written before the catalog reads as a catalog id", () => {
    // Exactly what an existing `files.ai_generation` value looks like.
    const legacyRow = JSON.stringify({ ...BASE, provider: "local-tts", model: "kokoro-82m" });
    const meta = parseAiGenerationMeta(legacyRow);
    expect(meta).not.toBeNull();
    expect(meta!.provider).toBe("kokoro");
  });

  it("keeps a legacy row's whole recipe — the reason this is not a z.enum", () => {
    // A closed enum would make this `null`, i.e. the asset preview's Generation
    // tab would vanish for the row rather than show one unfamiliar name.
    const legacyRow = JSON.stringify({
      ...BASE,
      provider: "fal-ai",
      costEstimate: { amount: 0.4, currency: "USD", tier: "veo-3.1-fast/720p" },
      providerJobId: "req-123",
    });
    const meta = parseAiGenerationMeta(legacyRow);
    expect(meta).not.toBeNull();
    expect(meta!.provider).toBe("fal");
    expect(meta!.model).toBe("veo3.1-fast");
    expect(meta!.prompt).toBe("a cat");
    expect(meta!.costEstimate).toEqual({ amount: 0.4, currency: "USD", tier: "veo-3.1-fast/720p" });
    expect(meta!.providerJobId).toBe("req-123");
  });

  it("accepts a provider the catalog has never heard of", () => {
    // libi does not own the user's MCP config any more: an agent generating
    // through a provider they connected themselves must still be able to record
    // provenance for it.
    const parsed = aiGenerationMetaSchema.parse({ ...BASE, provider: "some-other-provider" });
    expect(parsed.provider).toBe("some-other-provider");
    expect(isProviderId(parsed.provider)).toBe(false);
  });

  it("still rejects a provider that is missing or empty", () => {
    expect(() => aiGenerationMetaSchema.parse({ ...BASE, provider: "" })).toThrow();
    expect(() => aiGenerationMetaSchema.parse({ ...BASE })).toThrow();
    expect(() => aiGenerationMetaSchema.parse({ ...BASE, provider: 7 })).toThrow();
  });
});
