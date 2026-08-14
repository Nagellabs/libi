import { describe, it, expect } from "vitest";
import {
  keyframeMarkerX,
  isKeyframeAtPlayhead,
} from "@/lib/preview/keyframe-markers";

describe("keyframeMarkerX", () => {
  it("maps t=0 to the left edge and t=1 to the right edge", () => {
    expect(keyframeMarkerX(0, 200)).toBe(0);
    expect(keyframeMarkerX(1, 200)).toBe(200);
  });

  it("scales linearly across the bar width", () => {
    expect(keyframeMarkerX(0.5, 200)).toBe(100);
    expect(keyframeMarkerX(0.25, 400)).toBe(100);
  });

  it("clamps t outside [0,1] to the bar bounds", () => {
    expect(keyframeMarkerX(-0.2, 200)).toBe(0);
    expect(keyframeMarkerX(1.4, 200)).toBe(200);
  });

  it("returns 0 for a degenerate (non-positive) bar width", () => {
    expect(keyframeMarkerX(0.5, 0)).toBe(0);
    expect(keyframeMarkerX(0.5, -10)).toBe(0);
  });

  it("treats a non-finite t as 0", () => {
    expect(keyframeMarkerX(Number.NaN, 200)).toBe(0);
  });

  describe("insetPx — keep edge diamonds fully inside the bar", () => {
    it("nudges the t=0 / t=1 edge markers in by insetPx", () => {
      expect(keyframeMarkerX(0, 200, 8)).toBe(8);
      expect(keyframeMarkerX(1, 200, 8)).toBe(192);
    });

    it("leaves interior markers untouched (already within [inset, W-inset])", () => {
      expect(keyframeMarkerX(0.5, 200, 8)).toBe(100);
      expect(keyframeMarkerX(0.25, 400, 8)).toBe(100);
    });

    it("also insets out-of-range (clamped) markers", () => {
      expect(keyframeMarkerX(-0.5, 200, 8)).toBe(8);
      expect(keyframeMarkerX(1.5, 200, 8)).toBe(192);
    });

    it("clamps the inset to the bar midpoint on a bar too narrow for it", () => {
      // barW=10, inset=8 → inset clamps to 5 → every marker lands at the center.
      expect(keyframeMarkerX(0, 10, 8)).toBe(5);
      expect(keyframeMarkerX(1, 10, 8)).toBe(5);
    });

    it("insetPx=0 (default) is the un-inset behavior", () => {
      expect(keyframeMarkerX(0, 200, 0)).toBe(0);
      expect(keyframeMarkerX(1, 200)).toBe(200);
    });
  });
});

describe("isKeyframeAtPlayhead", () => {
  // 4s window at 30fps → 120 frames; 1-frame tolerance = 1/120 ≈ 0.00833.
  const dur = 4;
  const fps = 30;

  it("is true for an exact match", () => {
    expect(isKeyframeAtPlayhead(0.5, 0.5, dur, fps)).toBe(true);
  });

  it("is true within one frame of the playhead", () => {
    // half a frame away
    expect(isKeyframeAtPlayhead(0.5 + 1 / 240, 0.5, dur, fps)).toBe(true);
  });

  it("is false more than one frame away", () => {
    // two frames away
    expect(isKeyframeAtPlayhead(0.5 + 2 / 120, 0.5, dur, fps)).toBe(false);
  });

  it("falls back to exact equality for a degenerate window", () => {
    expect(isKeyframeAtPlayhead(0.3, 0.3, 0, fps)).toBe(true);
    expect(isKeyframeAtPlayhead(0.3, 0.30001, 0, fps)).toBe(false);
  });
});
