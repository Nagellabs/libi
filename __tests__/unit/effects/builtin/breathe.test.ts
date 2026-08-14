import { describe, it } from "vitest";
import { breatheEffect } from "@/lib/effects/builtin/breathe";
import { assertMotionSignature } from "@/lib/effects/__tests__/effect-harness";
describe("breathe effect", () => {
  it("scale and opacity are seamless loops", () => {
    assertMotionSignature(breatheEffect, "loop", { scale: { seamless: true }, opacity: { seamless: true } }, { amount: 0.06 });
  });
});
