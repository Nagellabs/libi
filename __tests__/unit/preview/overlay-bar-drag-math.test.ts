import { describe, it, expect } from "vitest";
import { clampBarTiming, type LaneView } from "@/lib/preview/lane-bar-geometry";

/**
 * Pins the load-bearing drag math that `OverlayBar.startDrag` embeds: a
 * horizontal pixel delta is converted to a seconds delta via the affine
 * `totalSeconds / trackWidth` factor, then composed with `clampBarTiming` per
 * gesture mode (move / trim-l / trim-r). The component itself is a thin React
 * wrapper around these tested primitives; this guards the math that lives
 * inline in the handler.
 */

// 600px wide track spanning 300 frames @ 30fps = 10 seconds.
const view: LaneView = { trackWidth: 600, totalFrames: 300, fps: 30 };
const totalSeconds = view.totalFrames / view.fps; // 10

/** The exact delta-seconds factor the component uses for a px drag. */
function deltaSecFor(deltaPx: number): number {
  return deltaPx * (totalSeconds > 0 && view.trackWidth > 0 ? totalSeconds / view.trackWidth : 0);
}

describe("overlay-bar drag math (move)", () => {
  it("moving the body right by 60px shifts startTime by +1s, keeps duration", () => {
    const start0 = 2;
    const dur0 = 3;
    const deltaSec = deltaSecFor(60); // 60px / 600px * 10s = 1s
    const next = clampBarTiming({ startTime: start0 + deltaSec, duration: dur0 }, totalSeconds);
    expect(next.startTime).toBeCloseTo(3, 5);
    expect(next.duration).toBeCloseTo(3, 5);
  });

  it("moving left past 0 clamps startTime to 0", () => {
    const start0 = 0.5;
    const dur0 = 2;
    const deltaSec = deltaSecFor(-120); // -2s
    const next = clampBarTiming({ startTime: start0 + deltaSec, duration: dur0 }, totalSeconds);
    expect(next.startTime).toBe(0);
    expect(next.duration).toBeCloseTo(2, 5);
  });
});

describe("overlay-bar drag math (trim-l)", () => {
  it("dragging the left edge right shrinks duration and advances startTime", () => {
    const start0 = 2;
    const dur0 = 4;
    const deltaSec = deltaSecFor(60); // +1s
    const next = clampBarTiming(
      { startTime: start0 + deltaSec, duration: dur0 - deltaSec },
      totalSeconds,
    );
    expect(next.startTime).toBeCloseTo(3, 5);
    expect(next.duration).toBeCloseTo(3, 5);
  });
});

describe("overlay-bar drag math (trim-r)", () => {
  it("dragging the right edge right widens duration, keeps startTime", () => {
    const start0 = 1;
    const dur0 = 2;
    const deltaSec = deltaSecFor(120); // +2s
    const next = clampBarTiming(
      { startTime: start0, duration: dur0 + deltaSec },
      totalSeconds,
    );
    expect(next.startTime).toBeCloseTo(1, 5);
    expect(next.duration).toBeCloseTo(4, 5);
  });

  it("trimming to near-zero enforces the minimum positive duration", () => {
    const start0 = 1;
    const dur0 = 2;
    const deltaSec = deltaSecFor(-600); // -10s → would be negative
    const next = clampBarTiming(
      { startTime: start0, duration: dur0 + deltaSec },
      totalSeconds,
    );
    expect(next.duration).toBeGreaterThan(0);
  });
});
