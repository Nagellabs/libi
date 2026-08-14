import { describe, it } from "vitest";
import { waveEffect } from "@/lib/effects/builtin/wave";
import { assertMotionSignature } from "@/lib/effects/__tests__/effect-harness";
describe("wave effect", () => {
  it("dy is a seamless sine loop", () => {
    assertMotionSignature(waveEffect, "loop", { dy: { seamless: true } }, { amplitude: 12 });
  });
});
