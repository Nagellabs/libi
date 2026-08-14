import { describe, it, expect } from "vitest";
import { glitchEffect } from "@/lib/effects/builtin/glitch";

describe("glitch effect", () => {
  it("jitters and flickers within bounds (deterministic)", () => {
    let movedSomewhere = false;
    for (let i = 0; i <= 20; i++) {
      const d = glitchEffect.animate(i / 20, { intensity: 8 });
      if (Math.abs(d.dx ?? 0) > 0.01) movedSomewhere = true;
      expect(d.opacity!).toBeGreaterThan(0);
      expect(d.opacity!).toBeLessThanOrEqual(1);
    }
    expect(movedSomewhere).toBe(true);
  });
  it("is deterministic across calls", () => {
    expect(glitchEffect.animate(0.3, { intensity: 8 })).toEqual(glitchEffect.animate(0.3, { intensity: 8 }));
  });
});
