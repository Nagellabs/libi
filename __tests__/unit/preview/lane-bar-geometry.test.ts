import { describe, it, expect } from "vitest";
import {
  laneBarRect,
  pxToSeconds,
  clampBarTiming,
} from "@/lib/preview/lane-bar-geometry";

// A timeline 600px wide spanning 300 total frames @ 30fps = 10 seconds.
const view = { trackWidth: 600, totalFrames: 300, fps: 30 };

describe("laneBarRect", () => {
  it("maps an overlay [startTime,duration] to {leftPx,widthPx}", () => {
    // 2s start, 4s duration over a 10s/600px track → left 120, width 240
    const r = laneBarRect({ startTime: 2, duration: 4 }, view);
    expect(r.leftPx).toBeCloseTo(120, 5);
    expect(r.widthPx).toBeCloseTo(240, 5);
  });

  it("a zero-frame view yields a zero-width bar (no NaN)", () => {
    const r = laneBarRect({ startTime: 1, duration: 1 }, { trackWidth: 600, totalFrames: 0, fps: 30 });
    expect(r.leftPx).toBe(0);
    expect(r.widthPx).toBe(0);
  });
});

describe("pxToSeconds", () => {
  it("is the inverse of laneBarRect's left mapping", () => {
    expect(pxToSeconds(120, view)).toBeCloseTo(2, 5);
    expect(pxToSeconds(360, view)).toBeCloseTo(6, 5);
  });
  it("clamps below 0 and never returns NaN on a zero-frame view", () => {
    expect(pxToSeconds(-50, view)).toBe(0);
    expect(pxToSeconds(50, { trackWidth: 600, totalFrames: 0, fps: 30 })).toBe(0);
  });
});

describe("clampBarTiming", () => {
  const totalSeconds = 10; // 300 / 30

  it("keeps a bar fully inside [0,totalSeconds]", () => {
    const c = clampBarTiming({ startTime: -2, duration: 3 }, totalSeconds);
    expect(c.startTime).toBe(0);
    expect(c.duration).toBe(3);
  });

  it("shifts a bar that overflows the end back inside", () => {
    const c = clampBarTiming({ startTime: 9, duration: 4 }, totalSeconds);
    // can't extend past 10 → start pulled to 6 so 6+4=10
    expect(c.startTime).toBe(6);
    expect(c.duration).toBe(4);
  });

  it("clamps a duration longer than the whole timeline", () => {
    const c = clampBarTiming({ startTime: 0, duration: 99 }, totalSeconds);
    expect(c.startTime).toBe(0);
    expect(c.duration).toBe(10);
  });

  it("enforces a minimum positive duration", () => {
    const c = clampBarTiming({ startTime: 5, duration: 0 }, totalSeconds);
    expect(c.duration).toBeGreaterThan(0);
  });
});
