import { describe, it, expect } from "vitest";
import { iou, matchByIoU } from "@/lib/tracking/iou-match";

describe("iou", () => {
  it("returns 1 for identical boxes", () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 })).toBeCloseTo(1);
  });
  it("returns 0 for non-overlapping boxes", () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 100, y: 100, w: 10, h: 10 })).toBe(0);
  });
  it("returns 0.25 for half-overlap on one axis", () => {
    // boxes: [0..10] vs [5..15] in x, full overlap in y.
    // intersection = 5*10 = 50; union = 100 + 100 - 50 = 150. → 1/3
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 })).toBeCloseTo(1 / 3);
  });
});

describe("matchByIoU", () => {
  it("returns null when no detections", () => {
    expect(matchByIoU({ x: 0, y: 0, w: 10, h: 10 }, [])).toBeNull();
  });
  it("returns null when best IoU below threshold", () => {
    expect(
      matchByIoU({ x: 0, y: 0, w: 10, h: 10 }, [{ x: 100, y: 100, w: 10, h: 10 }], { minIou: 0.1 }),
    ).toBeNull();
  });
  it("picks the highest-IoU detection", () => {
    const prev = { x: 0, y: 0, w: 10, h: 10 };
    const detections = [
      { x: 50, y: 50, w: 10, h: 10 }, // far
      { x: 2, y: 0, w: 10, h: 10 },   // close
      { x: 5, y: 0, w: 10, h: 10 },   // medium
    ];
    const match = matchByIoU(prev, detections);
    expect(match).toEqual({ x: 2, y: 0, w: 10, h: 10 });
  });
});
