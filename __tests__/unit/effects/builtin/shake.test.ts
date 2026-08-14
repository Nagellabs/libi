// __tests__/unit/effects/builtin/shake.test.ts
import { describe, it, expect } from "vitest";
import { shakeEffect } from "@/lib/effects/builtin/shake";
import { assertMotionSignature } from "@/lib/effects/__tests__/effect-harness";

describe("shake effect", () => {
  it("dx/dy stay within ±amount and are seamless", () => {
    assertMotionSignature(shakeEffect, "loop", { dx: { seamless: true }, dy: { seamless: true } }, { amount: 8 });
    for (let i = 0; i <= 20; i++) {
      const d = shakeEffect.animate(i / 20, { amount: 8 });
      expect(Math.abs(d.dx ?? 0)).toBeLessThanOrEqual(8 + 1e-6);
      expect(Math.abs(d.dy ?? 0)).toBeLessThanOrEqual(8 + 1e-6);
    }
  });
  it("is deterministic (no Math.random)", () => {
    expect(shakeEffect.animate(0.3, { amount: 8 })).toEqual(shakeEffect.animate(0.3, { amount: 8 }));
  });
});
