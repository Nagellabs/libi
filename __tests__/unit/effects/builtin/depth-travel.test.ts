// __tests__/unit/effects/builtin/depth-travel.test.ts
import { describe, it, expect } from "vitest";
import { depthTravelEffect } from "@/lib/effects/builtin/depth-travel";
import { assertMotionSignature } from "@/lib/effects/__tests__/effect-harness";

describe("depth-travel effect", () => {
  it("forward: scale increases AND blur decreases toward the front", () => {
    assertMotionSignature(depthTravelEffect, "in",
      { scale: { monotonic: "up", to: 1 }, blurPx: { monotonic: "down", to: 0 } },
      { direction: "forward" });
  });
  it("identity at the front (p=1, forward)", () => {
    expect(depthTravelEffect.animate(1, { direction: "forward" })).toEqual({});
  });
  it("supports in/out/loop and base scenes", () => {
    expect(depthTravelEffect.meta.phases).toEqual(expect.arrayContaining(["in", "out", "loop"]));
    expect(depthTravelEffect.meta.supports).toContain("scene");
  });
});
