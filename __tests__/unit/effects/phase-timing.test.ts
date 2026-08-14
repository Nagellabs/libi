// __tests__/unit/effects/phase-timing.test.ts
import { describe, it, expect } from "vitest";
import { inProgress, outProgress, loopPhase } from "@/lib/effects/phase-timing";

describe("phase-timing", () => {
  // element: starts at t=2s, duration 4s → window [2,6]. in/out windows 1s.
  it("inProgress ramps 0→1 over the first durationMs then clamps to 1", () => {
    expect(inProgress(2.0, 2, 4, 1000)).toBeCloseTo(0, 5);
    expect(inProgress(2.5, 2, 4, 1000)).toBeCloseTo(0.5, 5);
    expect(inProgress(3.0, 2, 4, 1000)).toBeCloseTo(1, 5);
    expect(inProgress(5.0, 2, 4, 1000)).toBeCloseTo(1, 5); // past the in-window
  });

  it("outProgress is 0 until the out-window, then ramps to exactly 1 at element end", () => {
    expect(outProgress(3.0, 2, 4, 1000)).toBeCloseTo(0, 5); // before out-window
    expect(outProgress(5.0, 2, 4, 1000)).toBeCloseTo(0, 5); // out-window starts at t=5
    expect(outProgress(5.5, 2, 4, 1000)).toBeCloseTo(0.5, 5);
    expect(outProgress(6.0, 2, 4, 1000)).toBeCloseTo(1, 5);
  });

  it("loopPhase wraps 0→1 across a fixed period and is seamless", () => {
    // period 2s; at t=2 (window start) phase 0, t=3 → 0.5, t=4 → 0 again
    expect(loopPhase(2.0, 2, 2000)).toBeCloseTo(0, 5);
    expect(loopPhase(3.0, 2, 2000)).toBeCloseTo(0.5, 5);
    expect(loopPhase(4.0, 2, 2000)).toBeCloseTo(0, 5);
  });

  it("a durationMs longer than the element clamps to the element length", () => {
    // in window 10s but element only 4s → at t=6 (end) progress is 1
    expect(inProgress(6.0, 2, 4, 10000)).toBeCloseTo(1, 5);
  });
});
