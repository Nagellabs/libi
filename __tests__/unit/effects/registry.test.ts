// __tests__/unit/effects/registry.test.ts
import { describe, it, expect } from "vitest";
import { findEffect, listEffects, isKnownEffectId } from "@/lib/effects/registry";

describe("effect registry", () => {
  it("isKnownEffectId is false for nonsense", () => {
    expect(isKnownEffectId("definitely-not-real")).toBe(false);
  });

  it("findEffect returns undefined for unknown ids", () => {
    expect(findEffect("definitely-not-real")).toBeUndefined();
  });

  it("listEffects filters by kind and phase", () => {
    // Once effects exist, "fade" supports text + phase in.
    const forText = listEffects({ kind: "text", phase: "in" });
    // The set is registry-derived; assert it never contains an effect that
    // doesn't support the filter.
    for (const e of forText) {
      expect(e.meta.supports).toContain("text");
      expect(e.meta.phases).toContain("in");
    }
  });
});
