import { describe, it, expect } from "vitest";
import { clamp01, elementTiming } from "@/lib/engine/overlay-timing";

describe("clamp01", () => {
  it("clamps below 0 and above 1", () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(0.3)).toBeCloseTo(0.3);
  });
});

describe("elementTiming", () => {
  it("remaps composition-global time to element-local", () => {
    // overlay at startTime=2s, duration=3s, fps=30. Global time 3.5s.
    const t = elementTiming(3.5, 30, 2, 3);
    expect(t.time).toBeCloseTo(1.5);          // 3.5 - 2
    expect(t.frame).toBe(45);                 // round(1.5 * 30)
    expect(t.totalFrames).toBe(90);           // round(3 * 30)
    expect(t.duration).toBe(3);
    expect(t.progress).toBeCloseTo(0.5);      // 1.5 / 3
  });

  it("clamps progress at the window edges", () => {
    expect(elementTiming(2, 30, 2, 3).progress).toBe(0);   // at start
    expect(elementTiming(5, 30, 2, 3).progress).toBe(1);   // at end
    expect(elementTiming(9, 30, 2, 3).progress).toBe(1);   // past end
  });

  it("guards zero/negative duration", () => {
    const t = elementTiming(1, 30, 0, 0);
    expect(t.totalFrames).toBe(1);
    expect(t.progress).toBe(0);
  });
});
