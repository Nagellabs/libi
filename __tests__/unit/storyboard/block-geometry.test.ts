import { describe, it, expect } from "vitest";
import { toPixelRect, toNormalizedRect } from "@/lib/storyboard/block-geometry";

describe("block-geometry", () => {
  it("normalized → pixel", () => {
    expect(toPixelRect({ x: 0.5, y: 0.25, w: 0.5, h: 0.5 }, 200, 400))
      .toEqual({ x: 100, y: 100, w: 100, h: 200 });
  });
  it("pixel → normalized (round trip)", () => {
    const n = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const px = toPixelRect(n, 1000, 1000);
    expect(toNormalizedRect(px, 1000, 1000)).toEqual(n);
  });
  it("clamps normalized to [0,1]", () => {
    const n = toNormalizedRect({ x: -50, y: 0, w: 5000, h: 100 }, 1000, 1000);
    expect(n.x).toBe(0);
    expect(n.w).toBe(1);
  });
});
