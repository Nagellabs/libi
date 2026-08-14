// __tests__/unit/effects/builtin/slide.test.ts
import { describe, it, expect } from "vitest";
import { slideEffect } from "@/lib/effects/builtin/slide";
import { assertMotionSignature } from "@/lib/effects/__tests__/effect-harness";

describe("slide effect", () => {
  it("dx eases from -distance to 0 (slide from left)", () => {
    assertMotionSignature(slideEffect, "in", { dx: { from: -300, to: 0 } }, { direction: "left", distance: 300 });
  });
  it("dy eases from +distance to 0 (slide from down)", () => {
    assertMotionSignature(slideEffect, "in", { dy: { from: 300, to: 0 } }, { direction: "down", distance: 300 });
  });
  it("rests exactly at home (delta 0) at p=1", () => {
    expect(slideEffect.animate(1, { direction: "left", distance: 300 })).toEqual({});
  });
});
