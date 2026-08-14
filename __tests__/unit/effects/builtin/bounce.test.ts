import { describe, it, expect } from "vitest";
import { bounceEffect } from "@/lib/effects/builtin/bounce";
import { assertMotionSignature, assertSettlesToIdentity, renderProof } from "@/lib/effects/__tests__/effect-harness";

describe("bounce effect", () => {
  it("dy settles to 0 (home) at p=1", () => {
    assertMotionSignature(bounceEffect, "in", { dy: { to: 0 } }, { direction: "down", distance: 200 });
    assertSettlesToIdentity(bounceEffect, { direction: "down", distance: 200 });
  });
  it("renders with translation during the in window", () => {
    const frames = renderProof("bounce", "in");
    expect(frames.some((f) => f.translated)).toBe(true);
  });
});
