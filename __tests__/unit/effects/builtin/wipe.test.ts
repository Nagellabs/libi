import { describe, it, expect } from "vitest";
import { wipeEffect } from "@/lib/effects/builtin/wipe";

describe("wipe effect", () => {
  it("reveal fraction grows 0→1; no clip at p=1", () => {
    expect(wipeEffect.animate(0, { edge: "left" }).clipReveal!.fraction).toBeCloseTo(0, 5);
    const mid = wipeEffect.animate(0.5, { edge: "left" }).clipReveal!.fraction;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(wipeEffect.animate(1, { edge: "left" }).clipReveal).toBeUndefined();
  });
});
