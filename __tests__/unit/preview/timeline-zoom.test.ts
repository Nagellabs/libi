import { describe, it, expect } from "vitest";
import {
  ZOOM_MIN_PX_PER_SEC, MAX_PX_PER_FRAME,
  fitPxPerSec, clampPxPerSec, contentWidth, zoomMultiplierLabel,
  applyWheelZoom, anchoredScrollLeft, maxPxPerSec,
} from "@/lib/preview/timeline-zoom";

const MAX_30FPS = maxPxPerSec(30); // 1200

describe("timeline-zoom", () => {
  it("fitPxPerSec fills the viewport", () => {
    expect(fitPxPerSec(1000, 10)).toBe(100); // 1000px / 10s
    expect(fitPxPerSec(0, 10)).toBe(ZOOM_MIN_PX_PER_SEC); // degenerate → min
    expect(fitPxPerSec(1000, 0)).toBe(ZOOM_MIN_PX_PER_SEC);
  });
  it("fitPxPerSec has no upper bound — a short comp in a wide viewport can exceed the zoom ceiling", () => {
    // 4000px viewport / 1s comp = 4000 px/sec, far past the 30fps ceiling
    // (1200). Fit is the floor, not a value clampPxPerSec ever touches — a
    // short piece must still exactly fill its panel.
    expect(fitPxPerSec(4000, 1)).toBe(4000);
    expect(fitPxPerSec(4000, 1)).toBeGreaterThan(MAX_30FPS);
  });
  it("clampPxPerSec bounds to [MIN, maxPx]", () => {
    expect(clampPxPerSec(0, MAX_30FPS)).toBe(ZOOM_MIN_PX_PER_SEC);
    expect(clampPxPerSec(1e9, MAX_30FPS)).toBe(MAX_30FPS);
    expect(clampPxPerSec(123, MAX_30FPS)).toBe(123);
  });
  it("contentWidth = pxPerSec * totalSeconds", () => {
    expect(contentWidth(100, 10)).toBe(1000);
  });
  it("zoomMultiplierLabel reads ×1 at fit", () => {
    expect(zoomMultiplierLabel(100, 100)).toBe("×1");
  });
  it("zoomMultiplierLabel keeps one decimal below ×10, stripping a trailing .0", () => {
    expect(zoomMultiplierLabel(245, 100)).toBe("×2.5"); // 2.45 → 2.5
    expect(zoomMultiplierLabel(996, 100)).toBe("×10"); // 9.96 rounds up to the ×10 boundary
  });
  it("zoomMultiplierLabel rounds to an integer at and above ×10", () => {
    expect(zoomMultiplierLabel(1000, 100)).toBe("×10"); // ratio exactly 10 — the >=10 branch, not the decimal one
    expect(zoomMultiplierLabel(1682.2, 10)).toBe("×168");
  });
  it("zoomMultiplierLabel clamps below-fit ratios to ×1", () => {
    expect(zoomMultiplierLabel(50, 100)).toBe("×1");
  });
  it("zoomMultiplierLabel treats a degenerate fitPx as ratio 1", () => {
    expect(zoomMultiplierLabel(500, 0)).toBe("×1");
    expect(zoomMultiplierLabel(500, Number.NaN)).toBe("×1");
  });
  it("applyWheelZoom multiplies + clamps to the given ceiling", () => {
    expect(applyWheelZoom({ pxPerSec: 100, factor: 1.1, maxPx: MAX_30FPS })).toBeCloseTo(110);
    expect(applyWheelZoom({ pxPerSec: MAX_30FPS, factor: 2, maxPx: MAX_30FPS })).toBe(MAX_30FPS);
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

describe("maxPxPerSec", () => {
  it("is MAX_PX_PER_FRAME × fps", () => {
    expect(maxPxPerSec(30)).toBe(1200);
    expect(maxPxPerSec(60)).toBe(2400);
    expect(MAX_PX_PER_FRAME).toBe(40);
  });
  it("falls back to a 30fps-equivalent ceiling for a non-finite or non-positive fps", () => {
    expect(maxPxPerSec(Number.NaN)).toBe(maxPxPerSec(30));
    expect(maxPxPerSec(Number.POSITIVE_INFINITY)).toBe(maxPxPerSec(30));
    expect(maxPxPerSec(0)).toBe(maxPxPerSec(30));
    expect(maxPxPerSec(-24)).toBe(maxPxPerSec(30));
  });
  it("never drops below ZOOM_MIN_PX_PER_SEC", () => {
    // An absurdly small fps (well under 1) would otherwise multiply out to
    // something below the min-zoom floor.
    expect(maxPxPerSec(0.001)).toBeGreaterThanOrEqual(ZOOM_MIN_PX_PER_SEC);
  });
});
