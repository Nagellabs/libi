import { describe, it, expect } from "vitest";
import {
  compToCtxTime,
  clipSourceRange,
  crossfadeGain,
} from "@/lib/audio/schedule-math";

describe("compToCtxTime", () => {
  it("maps composition time to ctx time at speed 1", () => {
    // anchor: comp 2.0 == ctx 100.0; comp 5.0 → ctx 103.0
    expect(compToCtxTime(5.0, 2.0, 100.0, 1)).toBeCloseTo(103.0, 6);
  });
  it("halves the ctx interval at speed 2", () => {
    expect(compToCtxTime(6.0, 2.0, 100.0, 2)).toBeCloseTo(102.0, 6);
  });
  it("returns the anchor ctx time at the anchor comp time", () => {
    expect(compToCtxTime(2.0, 2.0, 100.0, 1)).toBeCloseTo(100.0, 6);
  });
});

describe("clipSourceRange", () => {
  const clip = { startTime: 4, duration: 4, trimStart: 1 }; // sounds comp[4,8], source[1,5]

  it("returns the full source range when playhead is before the clip", () => {
    expect(clipSourceRange(clip, 0)).toEqual({ sourceStart: 1, sourceEnd: 5, compStart: 4 });
  });
  it("trims the source start when playhead is mid-clip", () => {
    // playhead comp 6.0 → 2s into the clip → source 3.0
    expect(clipSourceRange(clip, 6.0)).toEqual({ sourceStart: 3, sourceEnd: 5, compStart: 6 });
  });
  it("returns null when the clip is fully in the past", () => {
    expect(clipSourceRange(clip, 8.0)).toBeNull();
    expect(clipSourceRange(clip, 9.0)).toBeNull();
  });
});

describe("crossfadeGain", () => {
  it("is full in the middle", () => {
    expect(crossfadeGain(2.0, 4.0)).toBe(1);
  });
  it("ramps up from 0 at the start edge", () => {
    expect(crossfadeGain(0, 4.0)).toBe(0);
    expect(crossfadeGain(0.01, 4.0)).toBeCloseTo(0.5, 5); // ramp = 0.02
  });
  it("ramps down to 0 at the end edge", () => {
    expect(crossfadeGain(4.0, 4.0)).toBe(0);
  });
});
