import { describe, it, expect } from "vitest";
import { computePeaks, peaksWindow } from "@/lib/audio/peaks";

describe("computePeaks", () => {
  it("returns `buckets` normalized peaks (max abs per slice)", () => {
    const s = new Float32Array([0, 0.5, -0.9, 0.2, 1, -1, 0.1, 0]);
    const p = computePeaks(s, 4);
    expect(p).toHaveLength(4);
    expect(p[0]).toBeCloseTo(0.5); // max abs of [0, 0.5]
    expect(p[1]).toBeCloseTo(0.9); // max abs of [-0.9, 0.2]
    expect(p[2]).toBeCloseTo(1); // [1, -1]
    expect(p[3]).toBeCloseTo(0.1);
  });

  it("clamps to 1 and handles empty input", () => {
    expect(computePeaks(new Float32Array([2, -3]), 1)[0]).toBe(1);
    expect(computePeaks(new Float32Array([]), 3)).toEqual([0, 0, 0]);
  });
});

describe("peaksWindow", () => {
  const peaks = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]; // 10 over 10s

  it("slices to the [trimStart, trimStart+duration) window", () => {
    // 10s source, trimStart 2s, duration 4s → fraction [0.2, 0.6) → idx [2,6)
    expect(peaksWindow(peaks, 10, 2, 4)).toEqual([0.2, 0.3, 0.4, 0.5]);
  });

  it("returns the whole array when the window is unknown", () => {
    expect(peaksWindow(peaks, 0, 2, 4)).toBe(peaks);
    expect(peaksWindow(peaks, 10, 0, 0)).toBe(peaks);
  });
});
