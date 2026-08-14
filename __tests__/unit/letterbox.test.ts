/**
 * Unit: fitRect — pure letterbox/pillarbox math.
 *
 * Covers the cases the video scene renderer cares about: wider source
 * (letterbox), taller source (pillarbox), equal-aspect (full), and
 * degenerate (zero dimension) fallback.
 */
import { describe, it, expect } from "vitest";
import { fitRect } from "@/lib/engine/letterbox";

describe("fitRect", () => {
  it("returns the target rect when source and target share aspect ratio", () => {
    expect(fitRect(1920, 1080, 1920, 1080)).toEqual({
      x: 0, y: 0, w: 1920, h: 1080,
    });
  });

  it("letterboxes a wider source into a 16:9 target", () => {
    // 2.35:1 source into 16:9 composition → bars top and bottom.
    const r = fitRect(2350, 1000, 1920, 1080);
    expect(r.w).toBe(1920);
    expect(r.h).toBeLessThan(1080);
    expect(r.x).toBe(0);
    expect(r.y).toBeGreaterThan(0);
    // Visual centering: top+bottom bars roughly equal.
    const topBar = r.y;
    const bottomBar = 1080 - (r.y + r.h);
    expect(Math.abs(topBar - bottomBar)).toBeLessThanOrEqual(1);
  });

  it("pillarboxes a taller source into a 16:9 target", () => {
    // 9:16 vertical source into 16:9 composition → bars left and right.
    const r = fitRect(1080, 1920, 1920, 1080);
    expect(r.h).toBe(1080);
    expect(r.w).toBeLessThan(1920);
    expect(r.y).toBe(0);
    expect(r.x).toBeGreaterThan(0);
    const leftBar = r.x;
    const rightBar = 1920 - (r.x + r.w);
    expect(Math.abs(leftBar - rightBar)).toBeLessThanOrEqual(1);
  });

  it("falls back to the target rect when source dimensions are zero", () => {
    expect(fitRect(0, 0, 1920, 1080)).toEqual({
      x: 0, y: 0, w: 1920, h: 1080,
    });
    expect(fitRect(100, 0, 1920, 1080)).toEqual({
      x: 0, y: 0, w: 1920, h: 1080,
    });
  });

  it("returns integer coordinates (no sub-pixel drift)", () => {
    const r = fitRect(1234, 567, 1920, 1080);
    expect(Number.isInteger(r.x)).toBe(true);
    expect(Number.isInteger(r.y)).toBe(true);
    expect(Number.isInteger(r.w)).toBe(true);
    expect(Number.isInteger(r.h)).toBe(true);
  });
});
