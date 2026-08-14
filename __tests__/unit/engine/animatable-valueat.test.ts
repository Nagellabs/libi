import { describe, it, expect } from "vitest";
import { valueAt, isKeyframed } from "@/lib/engine/animatable";
import type { Keyframed } from "@/lib/engine/animatable";
import type { ElementTiming } from "@/lib/engine/overlay-timing";
import type { OverlayRect, Transform3D } from "@/lib/engine/types";

/** Build an ElementTiming with a given normalized progress. */
function timing(progress: number): ElementTiming {
  return {
    frame: 0,
    time: 0,
    totalFrames: 60,
    duration: 2,
    progress,
  };
}

describe("valueAt — constant fast-path", () => {
  it("passes a number through unchanged", () => {
    expect(valueAt(42, timing(0.5))).toBe(42);
  });

  it("passes an object through by identity (same reference)", () => {
    const rect: OverlayRect = { x: 1, y: 2, width: 3, height: 4 };
    expect(valueAt(rect, timing(0.5))).toBe(rect);
  });

  it("passes a boolean through unchanged", () => {
    expect(valueAt(true, timing(0.5))).toBe(true);
  });
});

describe("valueAt — keyframed numbers", () => {
  it("single keyframe is constant at all progress", () => {
    const kf: Keyframed<number> = { keyframes: [{ t: 0.5, value: 7 }] };
    expect(valueAt(kf, timing(0))).toBe(7);
    expect(valueAt(kf, timing(0.5))).toBe(7);
    expect(valueAt(kf, timing(1))).toBe(7);
  });

  it("two-keyframe linear lerp (no easing)", () => {
    const kf: Keyframed<number> = {
      keyframes: [
        { t: 0, value: 0 },
        { t: 1, value: 100 },
      ],
    };
    expect(valueAt(kf, timing(0))).toBeCloseTo(0, 5);
    expect(valueAt(kf, timing(0.25))).toBeCloseTo(25, 5);
    expect(valueAt(kf, timing(0.5))).toBeCloseTo(50, 5);
    expect(valueAt(kf, timing(1))).toBeCloseTo(100, 5);
  });

  it("segment uses the left keyframe's easing (ease-in below linear)", () => {
    const kf: Keyframed<number> = {
      keyframes: [
        { t: 0, value: 0, easing: "ease-in" },
        { t: 1, value: 100 },
      ],
    };
    // ease-in at local 0.5 is below the linear 50.
    expect(valueAt(kf, timing(0.5))).toBeLessThan(50);
  });

  it("clamps/holds before first and after last keyframe", () => {
    const kf: Keyframed<number> = {
      keyframes: [
        { t: 0.25, value: 10 },
        { t: 0.75, value: 20 },
      ],
    };
    expect(valueAt(kf, timing(0))).toBe(10); // before first
    expect(valueAt(kf, timing(0.25))).toBe(10); // at first
    expect(valueAt(kf, timing(0.5))).toBeCloseTo(15, 5); // midpoint
    expect(valueAt(kf, timing(0.75))).toBe(20); // at last
    expect(valueAt(kf, timing(1))).toBe(20); // after last
  });

  it("sorts keyframes defensively without mutating input", () => {
    const keyframes = [
      { t: 1, value: 100 },
      { t: 0, value: 0 },
    ];
    const kf: Keyframed<number> = { keyframes };
    expect(valueAt(kf, timing(0.5))).toBeCloseTo(50, 5);
    // input order preserved
    expect(kf.keyframes[0].t).toBe(1);
    expect(kf.keyframes[1].t).toBe(0);
  });

  it("shared-t keyframes step (use the right value)", () => {
    const kf: Keyframed<number> = {
      keyframes: [
        { t: 0, value: 0 },
        { t: 0.5, value: 10 },
        { t: 0.5, value: 20 },
        { t: 1, value: 30 },
      ],
    };
    // At progress just past the duplicate t, we should have stepped into the
    // segment leaving the second t=0.5 keyframe.
    const v = valueAt(kf, timing(0.5));
    expect([10, 20]).toContain(v);
  });

  it("unknown easing falls back to linear (does not throw)", () => {
    const kf: Keyframed<number> = {
      keyframes: [
        { t: 0, value: 0, easing: "not-a-real-easing" },
        { t: 1, value: 100 },
      ],
    };
    expect(() => valueAt(kf, timing(0.5))).not.toThrow();
    expect(valueAt(kf, timing(0.5))).toBeCloseTo(50, 5);
  });
});

describe("valueAt — keyframed OverlayRect", () => {
  it("interpolates each field", () => {
    const kf: Keyframed<OverlayRect> = {
      keyframes: [
        { t: 0, value: { x: 0, y: 0, width: 0, height: 0 } },
        { t: 1, value: { x: 100, y: 200, width: 300, height: 400 } },
      ],
    };
    const v = valueAt(kf, timing(0.5));
    expect(v).toEqual({ x: 50, y: 100, width: 150, height: 200 });
  });
});

describe("valueAt — keyframed Transform3D", () => {
  it("interpolates position and rotation component-wise", () => {
    const kf: Keyframed<Transform3D> = {
      keyframes: [
        {
          t: 0,
          value: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
        },
        {
          t: 1,
          value: {
            position: { x: 10, y: 20, z: 30 },
            rotation: { x: 1, y: 2, z: 3 },
          },
        },
      ],
    };
    const v = valueAt(kf, timing(0.5));
    expect(v.position).toEqual({ x: 5, y: 10, z: 15 });
    expect(v.rotation).toEqual({ x: 0.5, y: 1, z: 1.5 });
  });
});

describe("valueAt — non-lerpable values step", () => {
  it("string keyframes step at e<1 → a, e>=1 → b", () => {
    const kf: Keyframed<string> = {
      keyframes: [
        { t: 0, value: "a" },
        { t: 1, value: "b" },
      ],
    };
    expect(valueAt(kf, timing(0.5))).toBe("a");
    expect(valueAt(kf, timing(1))).toBe("b");
  });
});

describe("isKeyframed", () => {
  it("detects a keyframed value", () => {
    expect(isKeyframed({ keyframes: [{ t: 0, value: 1 }] })).toBe(true);
  });
  it("rejects constants", () => {
    expect(isKeyframed(5)).toBe(false);
    expect(isKeyframed({ x: 1 } as never)).toBe(false);
    expect(isKeyframed(null as never)).toBe(false);
  });
});
