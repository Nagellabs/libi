import { describe, it, expect } from "vitest";
import { resolveDrop } from "@/lib/preview/timeline-drop";

const lane = { left: 100, width: 400 }; // px

describe("resolveDrop", () => {
  it("maps mid-lane x to a proportional start time", () => {
    const r = resolveDrop({ clientX: 300, laneRect: lane, durationSec: 10, rowGroup: "graphics", rowZ: 3 });
    expect(r.startTime).toBeCloseTo(5, 3);
    expect(r.group).toBe("graphics");
    expect(r.z).toBe(3);
  });
  it("clamps left of the lane to 0", () => {
    expect(resolveDrop({ clientX: 40, laneRect: lane, durationSec: 10, rowGroup: "g", rowZ: 0 }).startTime).toBe(0);
  });
  it("clamps right of the lane to the duration", () => {
    expect(resolveDrop({ clientX: 999, laneRect: lane, durationSec: 10, rowGroup: "g", rowZ: 0 }).startTime).toBeCloseTo(10, 3);
  });
  it("degenerate zero-width lane → start 0", () => {
    expect(resolveDrop({ clientX: 120, laneRect: { left: 100, width: 0 }, durationSec: 10, rowGroup: "g", rowZ: 0 }).startTime).toBe(0);
  });
});
