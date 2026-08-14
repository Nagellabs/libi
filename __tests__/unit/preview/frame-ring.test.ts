import { describe, it, expect } from "vitest";
import { FrameRing } from "@/lib/preview/frame-ring";

describe("FrameRing.earliestEntry", () => {
  it("returns null when empty", () => {
    expect(new FrameRing<string>(4).earliestEntry()).toBeNull();
  });
  it("returns the oldest buffered entry (timestamp + value)", () => {
    const r = new FrameRing<string>(4);
    r.push(2, "c");
    r.push(0, "a");
    r.push(1, "b");
    expect(r.earliestEntry()).toEqual({ timestamp: 0, value: "a" });
  });
});

describe("FrameRing.frameAtOrNearestAhead", () => {
  const TOL = 0.5;
  it("returns null on an empty ring", () => {
    expect(new FrameRing<string>(8).frameAtOrNearestAhead(6.0, TOL)).toBeNull();
  });
  it("returns the latest frame at-or-before t when one exists", () => {
    const r = new FrameRing<string>(8);
    r.push(6.0, "a"); r.push(6.1, "b"); r.push(6.2, "c");
    expect(r.frameAtOrNearestAhead(6.15, TOL)).toBe("b");
  });
  it("serves the nearest-AHEAD frame within tolerance (seek-landing gap)", () => {
    // trim.start 6.000 requested, first decoded frame is 6.083 → nothing ≤ t,
    // but 6.083 is within 0.5s ahead → show it (not a freeze).
    const r = new FrameRing<string>(8);
    r.push(6.083, "x"); r.push(6.15, "y");
    expect(r.frameAtOrNearestAhead(6.0, TOL)).toBe("x");
  });
  it("returns null when the only frames are MORE than tolerance ahead", () => {
    // Genuinely-stale ring far ahead of t (e.g. mid backward-scrub before the
    // pump re-seeds) → no leak of a wrong frame.
    const r = new FrameRing<string>(8);
    r.push(6.6, "z");
    expect(r.frameAtOrNearestAhead(6.0, TOL)).toBeNull();
  });
});

describe("FrameRing", () => {
  it("latestAtOrBefore returns the newest entry with ts <= t", () => {
    const r = new FrameRing<string>(8);
    r.push(0, "a"); r.push(1, "b"); r.push(2, "c");
    expect(r.latestAtOrBefore(1.5)).toBe("b");
    expect(r.latestAtOrBefore(2)).toBe("c");
  });
  it("returns null when nothing is at or before t", () => {
    const r = new FrameRing<string>(8);
    r.push(5, "x");
    expect(r.latestAtOrBefore(1)).toBeNull();
  });
  it("evicts oldest beyond capacity", () => {
    const r = new FrameRing<string>(2);
    r.push(0, "a"); r.push(1, "b"); r.push(2, "c"); // "a" evicted
    expect(r.latestAtOrBefore(0)).toBeNull();
    expect(r.latestAtOrBefore(1)).toBe("b");
  });
  it("coversThrough returns the highest timestamp (or -Infinity when empty)", () => {
    const r = new FrameRing<string>(4);
    expect(r.coversThrough()).toBe(-Infinity);
    r.push(0, "a"); r.push(3, "b");
    expect(r.coversThrough()).toBe(3);
  });
  it("invokes the onEvict callback with the evicted value (for frame.close)", () => {
    const closed: string[] = [];
    const r = new FrameRing<string>(1, (v) => closed.push(v));
    r.push(0, "a"); r.push(1, "b");
    expect(closed).toEqual(["a"]);
  });
});
