import { describe, it } from "vitest";
import { blinkEffect } from "@/lib/effects/builtin/blink";
import { assertMotionSignature } from "@/lib/effects/__tests__/effect-harness";
describe("blink effect", () => {
  it("opacity is a seamless blink loop", () => {
    assertMotionSignature(blinkEffect, "loop", { opacity: { seamless: true } }, { min: 0.1 });
  });
});
