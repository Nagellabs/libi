import { describe, it, expect } from "vitest";
import { spinEffect } from "@/lib/effects/builtin/spin";
import { assertMotionSignature, assertSettlesToIdentity } from "@/lib/effects/__tests__/effect-harness";
describe("spin effect", () => {
  it("in/out settles rotation to 0 at p=1", () => {
    assertMotionSignature(spinEffect, "in", { rotateDeg: { to: 0 } }, { turns: 1 });
    assertSettlesToIdentity(spinEffect, { turns: 1 });
  });
  it("is an in/out-only effect (looping rotation is spin-360 / sway)", () => {
    expect(spinEffect.meta.phases).toEqual(["in", "out"]);
  });
});
