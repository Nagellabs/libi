// __tests__/unit/effects/builtin/pulse.test.ts
import { describe, it, expect } from "vitest";
import { pulseEffect } from "@/lib/effects/builtin/pulse";
import { assertMotionSignature } from "@/lib/effects/__tests__/effect-harness";

describe("pulse effect", () => {
  it("scale oscillates and is seamless across the loop", () => {
    assertMotionSignature(pulseEffect, "loop", { scale: { seamless: true, overshootAbove: 1, undershootBelow: 1 } }, { amount: 0.06 });
  });
  it("is loop-only", () => {
    expect(pulseEffect.meta.phases).toEqual(["loop"]);
  });
});
