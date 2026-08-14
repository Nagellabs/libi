import { describe, it } from "vitest";
import { blurEffect } from "@/lib/effects/builtin/blur";
import { assertMotionSignature, assertSettlesToIdentity } from "@/lib/effects/__tests__/effect-harness";

describe("blur effect", () => {
  it("blurPx decreases to 0 at p=1", () => {
    assertMotionSignature(blurEffect, "in", { blurPx: { monotonic: "down", to: 0 } }, { radius: 12 });
    assertSettlesToIdentity(blurEffect, { radius: 12 });
  });
});
