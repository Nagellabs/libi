import { describe, it } from "vitest";
import { swayEffect } from "@/lib/effects/builtin/sway";
import { assertMotionSignature } from "@/lib/effects/__tests__/effect-harness";
describe("sway effect", () => {
  it("rotateDeg is a seamless oscillation", () => {
    assertMotionSignature(swayEffect, "loop", { rotateDeg: { seamless: true } }, { angle: 6 });
  });
});
