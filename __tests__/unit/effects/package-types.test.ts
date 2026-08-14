import { describe, it, expect } from "vitest";
import { customEffectManifestSchema } from "@/lib/effects/package-types";

describe("customEffectManifestSchema", () => {
  it("accepts a valid manifest", () => {
    const r = customEffectManifestSchema.safeParse({
      id: "my-zoom", name: "My Zoom", family: "animation",
      phases: ["in"], supports: ["text", "image"], params: [],
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown family and empty supports", () => {
    expect(customEffectManifestSchema.safeParse({ id: "x", name: "X", family: "weird", phases: ["in"], supports: ["text"], params: [] }).success).toBe(false);
    expect(customEffectManifestSchema.safeParse({ id: "x", name: "X", family: "animation", phases: ["in"], supports: [], params: [] }).success).toBe(false);
  });

  it("rejects ids that are not filesystem-safe slugs", () => {
    expect(customEffectManifestSchema.safeParse({ id: "../evil", name: "X", family: "animation", phases: ["in"], supports: ["text"], params: [] }).success).toBe(false);
  });
});
