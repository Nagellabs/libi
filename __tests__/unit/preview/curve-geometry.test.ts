import { describe, it, expect } from "vitest";
import {
  unitToSvg,
  svgToUnit,
  clamp,
  parseCubicBezier,
  bezierForEasing,
  formatCubicBezier,
  sampleEasing,
  sampleEasingFn,
  bezierHandlesSvg,
  polylinePath,
  DEFAULT_BEZIER,
  type GraphBox,
} from "@/lib/preview/curve-geometry";

const BOX: GraphBox = { width: 100, height: 100, pad: 10 };

describe("curve-geometry unit↔svg mapping", () => {
  it("maps unit corners to the padded SVG box (y-up → y-down)", () => {
    // bottom-left of unit space (0,0) → bottom-left SVG (pad, height-pad)
    expect(unitToSvg(0, 0, BOX)).toEqual({ x: 10, y: 90 });
    // top-right of unit space (1,1) → top-right SVG (width-pad, pad)
    expect(unitToSvg(1, 1, BOX)).toEqual({ x: 90, y: 10 });
    // center
    expect(unitToSvg(0.5, 0.5, BOX)).toEqual({ x: 50, y: 50 });
  });

  it("svgToUnit is the inverse of unitToSvg", () => {
    for (const [ux, uy] of [
      [0, 0],
      [1, 1],
      [0.25, 0.75],
      [0.5, 0.5],
    ] as const) {
      const s = unitToSvg(ux, uy, BOX);
      const back = svgToUnit(s.x, s.y, BOX);
      expect(back.x).toBeCloseTo(ux, 6);
      expect(back.y).toBeCloseTo(uy, 6);
    }
  });

  it("svgToUnit can produce values outside [0,1] for overshoot handles", () => {
    // A y above the top edge → uy > 1 (overshoot control point).
    const above = svgToUnit(50, 0, BOX); // py=0 is above pad
    expect(above.y).toBeGreaterThan(1);
  });
});

describe("clamp", () => {
  it("clamps to bounds", () => {
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(2, 0, 1)).toBe(1);
    expect(clamp(0.3, 0, 1)).toBe(0.3);
  });
});

describe("parseCubicBezier", () => {
  it("parses a well-formed literal", () => {
    expect(parseCubicBezier("cubic-bezier(0.42, 0, 0.58, 1)")).toEqual([0.42, 0, 0.58, 1]);
  });
  it("accepts negative / overshoot values", () => {
    expect(parseCubicBezier("cubic-bezier(0.5,-0.2,0.5,1.3)")).toEqual([0.5, -0.2, 0.5, 1.3]);
  });
  it("rejects non-cubic-bezier strings", () => {
    expect(parseCubicBezier("ease-in-out")).toBeNull();
    expect(parseCubicBezier("cubic-bezier(1,2,3)")).toBeNull();
    expect(parseCubicBezier("cubic-bezier(a,b,c,d)")).toBeNull();
  });
});

describe("bezierForEasing", () => {
  it("returns a preset's bezier for a bézier-representable preset", () => {
    expect(bezierForEasing("ease-in")).toEqual([0.42, 0, 1, 1]);
    expect(bezierForEasing("linear")).toEqual([0, 0, 1, 1]);
  });
  it("returns null for fn-only presets (bounce/elastic)", () => {
    expect(bezierForEasing("bounce-out")).toBeNull();
    expect(bezierForEasing("elastic-out")).toBeNull();
  });
  it("parses a cubic-bezier literal", () => {
    expect(bezierForEasing("cubic-bezier(0.1,0.2,0.3,0.4)")).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
  it("falls back to default for undefined / unknown", () => {
    expect(bezierForEasing(undefined)).toEqual(DEFAULT_BEZIER);
    expect(bezierForEasing("nonsense")).toEqual(DEFAULT_BEZIER);
  });
});

describe("formatCubicBezier", () => {
  it("round-trips through parseCubicBezier", () => {
    const b = [0.25, 0.1, 0.75, 0.9] as const;
    const str = formatCubicBezier([...b]);
    expect(str.startsWith("cubic-bezier(")).toBe(true);
    expect(parseCubicBezier(str)).toEqual([0.25, 0.1, 0.75, 0.9]);
  });
  it("trims trailing zeros", () => {
    expect(formatCubicBezier([0, 0, 1, 1])).toBe("cubic-bezier(0,0,1,1)");
  });
});

describe("sampleEasing", () => {
  it("samples n+1 points from x=0 to x=1, pinned at the ends", () => {
    const pts = sampleEasing("ease-in-out", 10);
    expect(pts).toHaveLength(11);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[10].x).toBe(1);
    expect(pts[10].y).toBeCloseTo(1, 6);
  });

  it("linear samples lie on y=x", () => {
    const pts = sampleEasing("linear", 8);
    for (const p of pts) expect(p.y).toBeCloseTo(p.x, 6);
  });

  it("bounce-out (fn-only) stays within a sane range and ends at 1", () => {
    const pts = sampleEasing("bounce-out", 32);
    expect(pts[0].y).toBeCloseTo(0, 6);
    expect(pts[pts.length - 1].y).toBeCloseTo(1, 6);
    // Bounce y is bounded in [0,1].
    for (const p of pts) {
      expect(p.y).toBeGreaterThanOrEqual(-0.001);
      expect(p.y).toBeLessThanOrEqual(1.001);
    }
  });

  it("ease-in is below linear in the middle (slow start)", () => {
    const easeIn = sampleEasing("ease-in", 20);
    const mid = easeIn.find((p) => Math.abs(p.x - 0.5) < 1e-9);
    expect(mid).toBeDefined();
    expect(mid!.y).toBeLessThan(0.5);
  });
});

describe("sampleEasingFn", () => {
  it("respects the sample count", () => {
    expect(sampleEasingFn((x) => x, 4)).toHaveLength(5);
  });
});

describe("bezierHandlesSvg", () => {
  it("pins p0 at (0,0) and p3 at (1,1) in SVG space, with control points between", () => {
    const h = bezierHandlesSvg([0.42, 0, 0.58, 1], BOX);
    expect(h.p0).toEqual(unitToSvg(0, 0, BOX));
    expect(h.p3).toEqual(unitToSvg(1, 1, BOX));
    expect(h.c1).toEqual(unitToSvg(0.42, 0, BOX));
    expect(h.c2).toEqual(unitToSvg(0.58, 1, BOX));
  });
});

describe("polylinePath", () => {
  it("builds an M…L path and starts with M", () => {
    const d = polylinePath([{ x: 0, y: 0 }, { x: 1, y: 1 }], BOX);
    expect(d.startsWith("M")).toBe(true);
    expect(d).toContain("L");
  });
  it("returns empty for no points", () => {
    expect(polylinePath([], BOX)).toBe("");
  });
});
