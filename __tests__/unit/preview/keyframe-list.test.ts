import { describe, it, expect } from "vitest";
import { keyframeRows, easingLabelFor, easingAt } from "@/lib/preview/keyframe-list";
import type { Overlay } from "@/lib/engine/types";

/** Minimal text overlay with keyframes on the rect track (one time per key). */
function overlayWithKeyframes(
  duration: number,
  keys: Array<{ t: number; easing?: string }>,
): Overlay {
  return {
    id: "ov1",
    kind: "text",
    startTime: 0,
    duration,
    z: 0,
    rect: { x: 0, y: 0, width: 100, height: 40 },
    text: "hi",
    keyframes: {
      rect: {
        keyframes: keys.map((k) => ({
          t: k.t,
          value: { x: 0, y: 0, width: 100, height: 40 },
          easing: k.easing,
        })),
      },
    },
  } as unknown as Overlay;
}

describe("easingLabelFor", () => {
  it("returns em-dash end for the last keyframe", () => {
    expect(easingLabelFor("ease-in-out", true)).toBe("— end —");
    expect(easingLabelFor(undefined, true)).toBe("— end —");
    expect(easingLabelFor("cubic-bezier(0.1,0.2,0.3,0.4)", true)).toBe("— end —");
  });

  it("returns the preset label for a known preset id", () => {
    expect(easingLabelFor("ease-in-out", false)).toBe("Ease in-out");
    expect(easingLabelFor("linear", false)).toBe("Linear");
    expect(easingLabelFor("bounce-out", false)).toBe("Bounce out");
  });

  it("returns Custom for a cubic-bezier literal", () => {
    expect(easingLabelFor("cubic-bezier(0.1,0.2,0.3,0.4)", false)).toBe("Custom");
  });

  it("returns Linear when the easing is undefined (effective default)", () => {
    expect(easingLabelFor(undefined, false)).toBe("Linear");
  });
});

describe("easingAt", () => {
  it("reads the left-keyframe easing across tracks at exact t", () => {
    const ov = overlayWithKeyframes(3, [
      { t: 0.1, easing: "ease-in" },
      { t: 0.5 },
    ]);
    expect(easingAt(ov, 0.1)).toBe("ease-in");
    expect(easingAt(ov, 0.5)).toBeUndefined();
  });

  it("returns undefined when no keyframes exist", () => {
    const ov = { id: "x", kind: "text", startTime: 0, duration: 3, z: 0, rect: {} } as unknown as Overlay;
    expect(easingAt(ov, 0.1)).toBeUndefined();
  });
});

describe("keyframeRows", () => {
  it("computes timecodes, easing labels, frames and isLast for a 3-keyframe overlay", () => {
    // duration 3s, 30fps. Keys at t = 0.1, 0.2778, 0.35.
    // seconds: 0.30, 0.8334, 1.05 → frames: 9, 25, 31.5→32? round(0.8334*30)=25, round(1.05*30)=31.5→32
    const ov = overlayWithKeyframes(3, [
      { t: 0.1, easing: "ease-in-out" },
      { t: 0.2778, easing: "cubic-bezier(0.1,0.2,0.3,0.4)" },
      { t: 0.35 }, // last — no outgoing segment
    ]);
    const rows = keyframeRows(ov, 30);
    expect(rows).toHaveLength(3);

    expect(rows[0].t).toBe(0.1);
    expect(rows[0].frame).toBe(9);
    expect(rows[0].timecode).toBe("00:00:00:09");
    expect(rows[0].easingId).toBe("ease-in-out");
    expect(rows[0].easingLabel).toBe("Ease in-out");
    expect(rows[0].isLast).toBe(false);

    expect(rows[1].t).toBe(0.2778);
    expect(rows[1].frame).toBe(25);
    expect(rows[1].timecode).toBe("00:00:00:25");
    expect(rows[1].easingLabel).toBe("Custom");
    expect(rows[1].isLast).toBe(false);

    // 0.35 * 3 * 30 = 31.4999… (float) → round → frame 31 → 1.033s → "00:00:01:01"
    // (frame 31 wraps past 30fps: hour 0, minute 0, second 1, frame 31%30 = 1).
    expect(rows[2].t).toBe(0.35);
    expect(rows[2].frame).toBe(31);
    expect(rows[2].timecode).toBe("00:00:01:01");
    expect(rows[2].isLast).toBe(true);
    expect(rows[2].easingLabel).toBe("— end —");
  });

  it("uses Linear label when a non-last keyframe has no easing", () => {
    const ov = overlayWithKeyframes(2, [{ t: 0.0 }, { t: 0.5 }]);
    const rows = keyframeRows(ov, 30);
    expect(rows[0].easingId).toBeUndefined();
    expect(rows[0].easingLabel).toBe("Linear");
    expect(rows[0].isLast).toBe(false);
    expect(rows[1].isLast).toBe(true);
  });

  it("returns [] for an overlay with no keyframes", () => {
    const ov = { id: "x", kind: "text", startTime: 0, duration: 3, z: 0, rect: {} } as unknown as Overlay;
    expect(keyframeRows(ov, 30)).toEqual([]);
  });
});
