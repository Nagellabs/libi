import { describe, it, expect } from "vitest";
import { valueAt, isKeyframed } from "@/lib/engine/animatable";
import type { ElementTiming } from "@/lib/engine/overlay-timing";

const t: ElementTiming = { frame: 0, time: 0, totalFrames: 1, duration: 1, progress: 0 };

describe("valueAt", () => {
  it("returns a plain constant unchanged", () => {
    expect(valueAt(0.5, t)).toBe(0.5);
    expect(valueAt({ x: 1, y: 2, w: 3, h: 4 }, t)).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });
  it("isKeyframed is false for a constant", () => {
    expect(isKeyframed(0.5)).toBe(false);
  });
});
