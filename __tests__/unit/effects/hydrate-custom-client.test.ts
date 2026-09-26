import { describe, it, expect, afterEach } from "vitest";
import {
  customEffectDefsFromPayload,
  hydrateCustomEffects,
} from "@/lib/effects/hydrate-custom-client";
import { findEffect, clearCustomEffects } from "@/lib/effects/registry";
import type { CustomEffectManifest } from "@/lib/effects/package-types";

const META: CustomEffectManifest = {
  id: "drift",
  name: "Drift",
  family: "animation",
  phases: ["in"],
  supports: ["text"],
  params: [],
};

afterEach(() => clearCustomEffects());

const HASH = "a".repeat(64);

describe("customEffectDefsFromPayload", () => {
  it("registers meta-only, curve-backed defs and never runs the source in this realm", () => {
    const g = globalThis as { __fxRan?: number };
    delete g.__fxRan;
    const { defs, customIds } = customEffectDefsFromPayload([
      { meta: META, source: "globalThis.__fxRan = 1; return { opacity: progress };", sourceHash: HASH },
      { meta: { ...META, id: "no-hash" }, source: "return {};", sourceHash: "nope" },
      { meta: { ...META, id: "BAD ID" }, source: "return {};", sourceHash: HASH },
    ]);
    expect(defs.map((d) => d.meta.id)).toEqual(["drift"]);
    expect(customIds.has("drift")).toBe(true);
    // No sampler configured: identity, and still nothing ran here.
    expect(defs[0]!.animate(0.5, {})).toEqual({});
    expect(g.__fxRan).toBeUndefined();
  });

  it("returns empty for an undefined payload", () => {
    const { defs } = customEffectDefsFromPayload(undefined);
    expect(defs).toEqual([]);
  });
});

describe("hydrateCustomEffects", () => {
  it("fetches and registers a disk custom effect into the registry", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({ custom: [{ meta: META, source: "return { dx: progress * 10 };", sourceHash: HASH }] }),
    })) as unknown as typeof fetch;
    const n = await hydrateCustomEffects(fakeFetch);
    expect(n).toBe(1);
    expect(findEffect("drift")?.meta.name).toBe("Drift");
  });

  it("is best-effort: a non-ok response leaves built-ins intact and returns 0", async () => {
    const fakeFetch = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    const n = await hydrateCustomEffects(fakeFetch);
    expect(n).toBe(0);
    expect(findEffect("drift")).toBeUndefined();
  });

  it("swallows a thrown fetch and returns 0", async () => {
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await hydrateCustomEffects(fakeFetch)).toBe(0);
  });
});
