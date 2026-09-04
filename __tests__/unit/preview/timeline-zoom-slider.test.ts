import { describe, it, expect } from "vitest";
import {
  sliderPosFromZoom,
  zoomFromSliderPos,
  maxPxPerSec,
} from "@/lib/preview/timeline-zoom";

const FIT = 40;
const MAX = maxPxPerSec(30); // 1200 — a representative frame-derived ceiling

describe("zoomFromSliderPos", () => {
  it("maps 0 to fit and 1 to the max zoom", () => {
    expect(zoomFromSliderPos(0, FIT, MAX)).toBeCloseTo(FIT, 6);
    expect(zoomFromSliderPos(1, FIT, MAX)).toBeCloseTo(MAX, 6);
  });

  it("is monotonically increasing between the endpoints", () => {
    const a = zoomFromSliderPos(0.25, FIT, MAX);
    const b = zoomFromSliderPos(0.5, FIT, MAX);
    const c = zoomFromSliderPos(0.75, FIT, MAX);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it("is logarithmic: the midpoint is the geometric mean of the endpoints", () => {
    expect(zoomFromSliderPos(0.5, FIT, MAX)).toBeCloseTo(Math.sqrt(FIT * MAX), 6);
  });

  it("clamps out-of-range positions to the endpoints", () => {
    expect(zoomFromSliderPos(-0.5, FIT, MAX)).toBeCloseTo(FIT, 6);
    expect(zoomFromSliderPos(2, FIT, MAX)).toBeCloseTo(MAX, 6);
  });

  it("returns fit when the zoom range is degenerate (fit at or above max)", () => {
    expect(zoomFromSliderPos(0.5, MAX, MAX)).toBe(MAX);
    expect(zoomFromSliderPos(1, MAX + 500, MAX)).toBe(MAX);
  });

  it("returns fit for a non-finite or non-positive fit", () => {
    expect(zoomFromSliderPos(0.5, 0, MAX)).toBe(0);
    expect(zoomFromSliderPos(0.5, Number.NaN, MAX)).toBeNaN();
  });
});

describe("sliderPosFromZoom", () => {
  it("maps fit to 0 and the max zoom to 1", () => {
    expect(sliderPosFromZoom(FIT, FIT, MAX)).toBeCloseTo(0, 6);
    expect(sliderPosFromZoom(MAX, FIT, MAX)).toBeCloseTo(1, 6);
  });

  it("round-trips with zoomFromSliderPos", () => {
    for (const pos of [0, 0.13, 0.5, 0.87, 1]) {
      expect(sliderPosFromZoom(zoomFromSliderPos(pos, FIT, MAX), FIT, MAX)).toBeCloseTo(pos, 6);
    }
  });

  it("clamps a zoom below fit or above max into 0…1", () => {
    expect(sliderPosFromZoom(FIT / 4, FIT, MAX)).toBe(0);
    expect(sliderPosFromZoom(MAX * 10, FIT, MAX)).toBe(1);
  });

  it("returns 0 when the zoom range is degenerate", () => {
    expect(sliderPosFromZoom(MAX, MAX, MAX)).toBe(0);
  });
});
