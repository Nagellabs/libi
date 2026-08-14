import { describe, it, expect } from "vitest";
import { nearestBeat, beatPulse } from "@/lib/engine/beat-helpers";

describe("nearestBeat", () => {
  it("returns the closest beat by absolute distance", () => {
    const a = nearestBeat([1, 2, 3], 1.4);
    expect(a.time).toBe(1);
    expect(a.index).toBe(0);
    expect(a.distance).toBeCloseTo(0.4, 5);
    const b = nearestBeat([1, 2, 3], 1.6);
    expect(b.time).toBe(2);
    expect(b.index).toBe(1);
    expect(b.distance).toBeCloseTo(0.4, 5);
  });

  it("returns the boundary beat on exact match", () => {
    expect(nearestBeat([1, 2, 3], 2)).toEqual({ time: 2, index: 1, distance: 0 });
  });

  it("handles t before the first beat", () => {
    expect(nearestBeat([1, 2, 3], 0)).toEqual({ time: 1, index: 0, distance: 1 });
  });

  it("handles t after the last beat", () => {
    expect(nearestBeat([1, 2, 3], 5)).toEqual({ time: 3, index: 2, distance: 2 });
  });

  it("returns a sentinel for an empty beat list", () => {
    expect(nearestBeat([], 1.4)).toEqual({ time: NaN, index: -1, distance: Infinity });
  });
});

describe("beatPulse", () => {
  it("returns 1 at exactly t==beat", () => {
    expect(beatPulse([1, 2, 3], 2)).toBeCloseTo(1, 5);
  });

  it("decays toward 0 along the release window", () => {
    const v = beatPulse([1], 1.125, { attack: 0.03, release: 0.25 });
    // half the release elapsed → linear envelope at ~0.5
    expect(v).toBeGreaterThan(0.4);
    expect(v).toBeLessThan(0.6);
  });

  it("ramps up during the attack window before the beat", () => {
    const v = beatPulse([1], 0.985, { attack: 0.03, release: 0.25 });
    // half the attack elapsed → ~0.5
    expect(v).toBeGreaterThan(0.4);
    expect(v).toBeLessThan(0.6);
  });

  it("returns 0 far from any beat", () => {
    expect(beatPulse([1, 5], 3)).toBeCloseTo(0, 5);
  });

  it("uses default attack 30ms / release 250ms when opts omitted", () => {
    // 250 ms past the beat → at the very end of the default release → ~0
    const v = beatPulse([1], 1.25);
    expect(v).toBeLessThan(0.05);
  });

  it("returns 0 on an empty beat list", () => {
    expect(beatPulse([], 1)).toBe(0);
  });
});
