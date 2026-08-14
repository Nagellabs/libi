import { describe, it, expect, afterEach } from "vitest";
import {
  compileCustomPayload,
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

describe("compileCustomPayload", () => {
  it("compiles good entries and skips ones whose source fails the sandbox", () => {
    const { defs, customIds } = compileCustomPayload([
      { meta: META, source: "return { opacity: progress };" },
      { meta: { ...META, id: "evil" }, source: "return require('fs');" },
    ]);
    expect(defs.map((d) => d.meta.id)).toEqual(["drift"]);
    expect(customIds.has("drift")).toBe(true);
    expect(customIds.has("evil")).toBe(false);
  });

  it("returns empty for an undefined payload", () => {
    const { defs } = compileCustomPayload(undefined);
    expect(defs).toEqual([]);
  });
});

describe("hydrateCustomEffects", () => {
  it("fetches, compiles, and registers a disk custom effect into the registry", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({ custom: [{ meta: META, source: "return { dx: progress * 10 };" }] }),
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
