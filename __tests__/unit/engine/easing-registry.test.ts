import { describe, it, expect } from "vitest";
import {
  EASING_PRESETS,
  cubicBezier,
  resolveEasing,
} from "@/lib/engine/easing-registry";
import { linear } from "@/lib/engine/animation";

describe("EASING_PRESETS catalog", () => {
  it("has the expected ids in order", () => {
    expect(EASING_PRESETS.map((p) => p.id)).toEqual([
      "linear",
      "ease-in",
      "ease-out",
      "ease-in-out",
      "ease-in-strong",
      "ease-out-strong",
      "ease-in-out-strong",
      "overshoot-in",
      "overshoot-out",
      "bounce-out",
      "elastic-out",
      "custom",
    ]);
  });

  it("every preset resolves to a runnable function", () => {
    for (const preset of EASING_PRESETS) {
      const fn = resolveEasing(preset.id);
      expect(typeof fn).toBe("function");
      // A resolvable function should map endpoints near 0 and 1.
      expect(fn(0)).toBeCloseTo(0, 4);
      expect(fn(1)).toBeCloseTo(1, 4);
    }
  });

  it("every preset carries either a bezier or a fn", () => {
    for (const preset of EASING_PRESETS) {
      expect(preset.bezier != null || preset.fn != null).toBe(true);
    }
  });
});

describe("cubicBezier", () => {
  it("maps endpoints to 0 and 1", () => {
    const fn = cubicBezier(0.42, 0, 0.58, 1);
    expect(fn(0)).toBeCloseTo(0, 5);
    expect(fn(1)).toBeCloseTo(1, 5);
  });

  it("linear bezier is ~identity at 0.25/0.5/0.75", () => {
    const fn = cubicBezier(0, 0, 1, 1);
    expect(fn(0.25)).toBeCloseTo(0.25, 3);
    expect(fn(0.5)).toBeCloseTo(0.5, 3);
    expect(fn(0.75)).toBeCloseTo(0.75, 3);
  });

  it("ease-in is below linear mid-range, ease-out is above", () => {
    const easeIn = cubicBezier(0.42, 0, 1, 1);
    const easeOut = cubicBezier(0, 0, 0.58, 1);
    expect(easeIn(0.5)).toBeLessThan(0.5);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
  });

  it("allows y-control points outside [0,1] for overshoot", () => {
    // easeOutBack-like control points overshoot above 1 somewhere.
    const fn = cubicBezier(0.34, 1.56, 0.64, 1);
    let overshot = false;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      if (fn(t) > 1.001) {
        overshot = true;
        break;
      }
    }
    expect(overshot).toBe(true);
  });
});

describe("resolveEasing", () => {
  it("undefined → linear", () => {
    const fn = resolveEasing(undefined);
    expect(fn(0.3)).toBeCloseTo(linear(0.3), 5);
    expect(fn(0.7)).toBeCloseTo(linear(0.7), 5);
  });

  it("unknown string → linear (never throws)", () => {
    expect(() => resolveEasing("garbage")).not.toThrow();
    const fn = resolveEasing("garbage");
    expect(fn(0.4)).toBeCloseTo(0.4, 5);
  });

  it("cubic-bezier(0,0,1,1) literal ≈ linear", () => {
    const fn = resolveEasing("cubic-bezier(0,0,1,1)");
    expect(fn(0.25)).toBeCloseTo(0.25, 3);
    expect(fn(0.5)).toBeCloseTo(0.5, 3);
    expect(fn(0.75)).toBeCloseTo(0.75, 3);
  });

  it("malformed cubic-bezier → linear", () => {
    const fn = resolveEasing("cubic-bezier(0,0,1)");
    expect(fn(0.5)).toBeCloseTo(0.5, 5);
  });

  it("named preset id resolves to its function", () => {
    const fn = resolveEasing("ease-in-out");
    expect(fn(0)).toBeCloseTo(0, 4);
    expect(fn(1)).toBeCloseTo(1, 4);
  });

  it("bounce-out preset (fn-backed) resolves and hits endpoints", () => {
    const fn = resolveEasing("bounce-out");
    expect(fn(0)).toBeCloseTo(0, 4);
    expect(fn(1)).toBeCloseTo(1, 4);
  });

  it("overshoot presets exceed 1 somewhere", () => {
    const fn = resolveEasing("overshoot-out");
    let overshot = false;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      if (fn(t) > 1.001) {
        overshot = true;
        break;
      }
    }
    expect(overshot).toBe(true);
  });
});
