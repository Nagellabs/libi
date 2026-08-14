import { describe, it, expect } from "vitest";
import { fauxLayerOffsets } from "@/lib/engine/text-3d/faux";

describe("fauxLayerOffsets", () => {
  it("single layer → [0]", () => {
    expect(fauxLayerOffsets(10, 1)).toEqual([0]);
  });
  it("depth 0 → all zeros", () => {
    expect(fauxLayerOffsets(0, 4)).toEqual([0, 0, 0, 0]);
  });
  it("spans [0, depth] back-to-front", () => {
    const o = fauxLayerOffsets(9, 4);
    expect(o.length).toBe(4);
    expect(Math.min(...o)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...o)).toBeLessThanOrEqual(9);
  });
  it("is ascending (back→front) and evenly spaced", () => {
    const o = fauxLayerOffsets(9, 4);
    expect(o[0]).toBe(0);
    expect(o[3]).toBe(9);
    expect(o[1]).toBeCloseTo(3);
    expect(o[2]).toBeCloseTo(6);
  });
  it("clamps non-positive / fractional layer counts to ≥1", () => {
    expect(fauxLayerOffsets(10, 0)).toEqual([0]);
    expect(fauxLayerOffsets(10, 2.9)).toEqual([0, 10]);
  });
});
