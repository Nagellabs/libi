// __tests__/unit/effects/harness.test.ts
import { describe, it, expect } from "vitest";
import { assertMotionSignature } from "@/lib/effects/__tests__/effect-harness";
import type { EffectDef } from "@/lib/effects/types";

const fade: EffectDef = {
  meta: { id: "fade", name: "Fade", family: "animation", phases: ["in"], supports: ["text"], params: [] },
  animate: (p) => ({ opacity: p }),
};
const pop: EffectDef = {
  meta: { id: "pop", name: "Pop", family: "animation", phases: ["in"], supports: ["text"], params: [] },
  // overshoots then settles to exactly 1
  animate: (p) => ({ scale: p < 1 ? 1 + 0.3 * Math.sin(p * Math.PI) : 1 }),
};

describe("assertMotionSignature", () => {
  it("passes a monotonic opacity fade", () => {
    expect(() =>
      assertMotionSignature(fade, "in", { opacity: { monotonic: "up", from: 0, to: 1 } }),
    ).not.toThrow();
  });

  it("passes a pop that overshoots and settles to exactly 1", () => {
    expect(() =>
      assertMotionSignature(pop, "in", { scale: { overshootAbove: 1, settleTo: 1 } }),
    ).not.toThrow();
  });

  it("throws when a settle expectation is violated", () => {
    const bad: EffectDef = { ...pop, animate: (p) => ({ scale: 1 + 0.3 * p }) }; // ends at 1.3
    expect(() =>
      assertMotionSignature(bad, "in", { scale: { settleTo: 1 } }),
    ).toThrow();
  });
});
