import { describe, it, expect } from "vitest";
import { flashEffect } from "@/lib/effects/builtin/flash";
import { assertMotionSignature, renderProof } from "@/lib/effects/__tests__/effect-harness";

describe("flash effect", () => {
  it("opacity settles to 1 at p=1", () => {
    assertMotionSignature(flashEffect, "in", { opacity: { to: 1 } });
  });
  it("renders changing alpha", () => {
    const frames = renderProof("flash", "in");
    const alphas = new Set(frames.map((f) => Math.round(f.alpha * 100)));
    expect(alphas.size).toBeGreaterThan(1);
  });
});
