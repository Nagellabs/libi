// __tests__/unit/effects/builtin/pop.test.ts
import { describe } from "vitest";
import { it, expect } from "vitest";
import { popEffect } from "@/lib/effects/builtin/pop";
import { assertMotionSignature } from "@/lib/effects/__tests__/effect-harness";

describe("pop effect", () => {
  it("scale overshoots above 1 then settles to exactly 1", () => {
    assertMotionSignature(popEffect, "in", { scale: { overshootAbove: 1, settleTo: 1 } });
  });
  it("opacity reaches 1 by p=1", () => {
    assertMotionSignature(popEffect, "in", { opacity: { to: 1, monotonic: "up" } });
  });
  it("delta is identity at p=1 (no residual)", () => {
    expect(popEffect.animate(1, {})).toEqual({});
  });
});
