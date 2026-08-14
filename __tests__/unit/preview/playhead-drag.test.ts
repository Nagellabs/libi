import { describe, it, expect } from "vitest";
import { frameFromClientX } from "@/lib/preview/playhead-drag";

describe("frameFromClientX", () => {
  it("maps a pointer x inside the lane to a proportional frame", () => {
    // lane [100, 1100), 100 frames → x=600 is halfway → frame ~= 49.5 → 50
    expect(
      frameFromClientX({ clientX: 600, laneLeft: 100, laneWidth: 1000, totalFrames: 100 }),
    ).toBe(50);
  });

  it("maps the lane's left edge to frame 0 and right edge to the last frame", () => {
    expect(
      frameFromClientX({ clientX: 100, laneLeft: 100, laneWidth: 1000, totalFrames: 100 }),
    ).toBe(0);
    expect(
      frameFromClientX({ clientX: 1100, laneLeft: 100, laneWidth: 1000, totalFrames: 100 }),
    ).toBe(99);
  });

  it("clamps a pointer outside the lane to the nearest edge", () => {
    expect(
      frameFromClientX({ clientX: -50, laneLeft: 100, laneWidth: 1000, totalFrames: 100 }),
    ).toBe(0);
    expect(
      frameFromClientX({ clientX: 9999, laneLeft: 100, laneWidth: 1000, totalFrames: 100 }),
    ).toBe(99);
  });

  it("returns 0 on degenerate inputs (no frames / zero-width lane)", () => {
    expect(
      frameFromClientX({ clientX: 500, laneLeft: 0, laneWidth: 1000, totalFrames: 0 }),
    ).toBe(0);
    expect(
      frameFromClientX({ clientX: 500, laneLeft: 0, laneWidth: 0, totalFrames: 100 }),
    ).toBe(0);
  });
});
