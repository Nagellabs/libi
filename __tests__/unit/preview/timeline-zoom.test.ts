import { describe, it, expect } from "vitest";
import {
  ZOOM_MIN_PX_PER_SEC, ZOOM_MAX_PX_PER_SEC,
  fitPxPerSec, clampPxPerSec, contentWidth, zoomFactorPercent,
  applyWheelZoom, anchoredScrollLeft,
} from "@/lib/preview/timeline-zoom";

describe("timeline-zoom", () => {
  it("fitPxPerSec fills the viewport", () => {
    expect(fitPxPerSec(1000, 10)).toBe(100); // 1000px / 10s
    expect(fitPxPerSec(0, 10)).toBe(ZOOM_MIN_PX_PER_SEC); // degenerate → min
    expect(fitPxPerSec(1000, 0)).toBe(ZOOM_MIN_PX_PER_SEC);
  });
  it("clampPxPerSec bounds to [MIN, MAX]", () => {
    expect(clampPxPerSec(0)).toBe(ZOOM_MIN_PX_PER_SEC);
    expect(clampPxPerSec(1e9)).toBe(ZOOM_MAX_PX_PER_SEC);
    expect(clampPxPerSec(123)).toBe(123);
  });
  it("contentWidth = pxPerSec * totalSeconds", () => {
    expect(contentWidth(100, 10)).toBe(1000);
  });
  it("zoomFactorPercent is 100 at fit", () => {
    expect(zoomFactorPercent(100, 100)).toBe(100);
    expect(zoomFactorPercent(200, 100)).toBe(200);
  });
  it("applyWheelZoom multiplies + clamps", () => {
    expect(applyWheelZoom({ pxPerSec: 100, factor: 1.1 })).toBeCloseTo(110);
    expect(applyWheelZoom({ pxPerSec: ZOOM_MAX_PX_PER_SEC, factor: 2 })).toBe(ZOOM_MAX_PX_PER_SEC);
  });
  it("anchoredScrollLeft keeps the time under the pointer fixed", () => {
    // pointer 300px into the viewport, scrollLeft 0, 100→200 px/s
    // time under pointer = 300/100 = 3s; after zoom that time sits at 600px,
    // so scrollLeft must become 600 - 300 = 300.
    expect(anchoredScrollLeft({ pointerX: 300, prevScrollLeft: 0, oldPxPerSec: 100, newPxPerSec: 200 })).toBe(300);
  });
  it("anchoredScrollLeft never returns negative", () => {
    expect(anchoredScrollLeft({ pointerX: 10, prevScrollLeft: 0, oldPxPerSec: 100, newPxPerSec: 50 })).toBe(0);
  });
});
