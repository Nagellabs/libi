import { describe, it, expect } from "vitest";
import { seekFrameFromClick } from "@/lib/preview/timeline-seek";

describe("seekFrameFromClick", () => {
  const view = { trackWidth: 1000, totalFrames: 300, fps: 30 }; // 10s, 100px/s
  it("maps a mid-lane click to the frame under the cursor", () => {
    // clientX 500px into a 1000px lane = 5s = frame 150
    expect(seekFrameFromClick({ clientX: 500, laneLeft: 0, view })).toBe(150);
  });
  it("accounts for the lane's left offset", () => {
    expect(seekFrameFromClick({ clientX: 700, laneLeft: 200, view })).toBe(150);
  });
  it("clamps to [0, totalFrames-1]", () => {
    expect(seekFrameFromClick({ clientX: -50, laneLeft: 0, view })).toBe(0);
    expect(seekFrameFromClick({ clientX: 99999, laneLeft: 0, view })).toBe(299);
  });
  it("returns 0 on a degenerate view", () => {
    expect(seekFrameFromClick({ clientX: 500, laneLeft: 0, view: { trackWidth: 0, totalFrames: 300, fps: 30 } })).toBe(0);
  });
});
