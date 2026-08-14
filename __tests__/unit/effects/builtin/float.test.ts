import { describe, it } from "vitest";
import { floatEffect } from "@/lib/effects/builtin/float";
import { assertMotionSignature } from "@/lib/effects/__tests__/effect-harness";
describe("float effect", () => {
  it("dx and dy are seamless loops", () => {
    assertMotionSignature(floatEffect, "loop", { dx: { seamless: true }, dy: { seamless: true } }, { amplitude: 10 });
  });
});
