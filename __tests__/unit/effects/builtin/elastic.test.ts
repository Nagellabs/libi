import { describe, it } from "vitest";
import { elasticEffect } from "@/lib/effects/builtin/elastic";
import { assertMotionSignature, assertSettlesToIdentity } from "@/lib/effects/__tests__/effect-harness";

describe("elastic effect", () => {
  it("scaleX overshoots 1 and settles to 1; settles to identity", () => {
    assertMotionSignature(elasticEffect, "in", { scaleX: { overshootAbove: 1, settleTo: 1 } }, { amount: 0.6 });
    assertSettlesToIdentity(elasticEffect, { amount: 0.6 });
  });
});
