import { describe, it, expect } from "vitest";

import { aspectOf, aspectLockedHeight } from "@/lib/overlays/size-field-math";

describe("aspectOf", () => {
  it("returns width/height for valid dimensions", () => {
    expect(aspectOf(200, 100)).toBe(2);
    expect(aspectOf(100, 200)).toBe(0.5);
    expect(aspectOf(120, 120)).toBe(1);
  });

  it("returns 1 (square fallback) when height is non-positive", () => {
    expect(aspectOf(200, 0)).toBe(1);
    expect(aspectOf(200, -50)).toBe(1);
  });
});

describe("aspectLockedHeight", () => {
  it("derives a proportional, rounded height for a new width", () => {
    // aspect 2 (200x100): width 400 → height 200
    expect(aspectLockedHeight(400, 2)).toBe(200);
    // aspect 0.5: width 100 → height 200
    expect(aspectLockedHeight(100, 0.5)).toBe(200);
  });

  it("rounds to whole pixels", () => {
    // aspect 3: width 100 → 33.33 → 33
    expect(aspectLockedHeight(100, 3)).toBe(33);
  });

  it("falls back to a square (height = round(width)) for a degenerate aspect", () => {
    expect(aspectLockedHeight(150, 0)).toBe(150);
    expect(aspectLockedHeight(150, -2)).toBe(150);
    expect(aspectLockedHeight(150, Number.NaN)).toBe(150);
    expect(aspectLockedHeight(150, Number.POSITIVE_INFINITY)).toBe(150);
  });

  it("round-trips: scaling width keeps the original aspect", () => {
    const w0 = 320;
    const h0 = 180;
    const aspect = aspectOf(w0, h0); // 16:9
    const w1 = 640;
    const h1 = aspectLockedHeight(w1, aspect);
    // height doubled with width → aspect preserved
    expect(h1).toBe(360);
    expect(aspectOf(w1, h1)).toBeCloseTo(aspect, 6);
  });
});
