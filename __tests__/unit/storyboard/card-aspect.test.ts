import { describe, it, expect } from "vitest";
import { cardAspect, parseAspectRatio, tileSize } from "@/lib/storyboard/card-aspect";
import type { GenSpec } from "@/lib/storyboard/types";

const gen = (ar?: string): GenSpec => ({ apiUrl: "u", model: "m", params: ar ? { aspect_ratio: ar } : {} });

describe("cardAspect", () => {
  it("reads the clip's aspect_ratio first", () => {
    expect(cardAspect({ clipGen: gen("16:9"), keyframeGen: gen("9:16") })).toBeCloseTo(16 / 9);
  });
  it("falls back to the keyframe's aspect_ratio", () => {
    expect(cardAspect({ keyframeGen: gen("1:1") })).toBe(1);
  });
  it("is null when neither spec sets one", () => {
    expect(cardAspect({})).toBeNull();
    expect(cardAspect({ clipGen: gen() })).toBeNull();
  });
  it("shares the parser with the renderer (W:H, WxH, W/H)", () => {
    expect(parseAspectRatio("4x3")).toBeCloseTo(4 / 3);
    expect(parseAspectRatio("nope")).toBeNull();
  });
});

describe("tileSize", () => {
  it("keeps the 64×114 portrait tile for 9:16", () => {
    expect(tileSize(64, 9 / 16)).toEqual({ width: 64, height: 114 });
  });
  it("widens a landscape tile to the same long edge", () => {
    expect(tileSize(64, 16 / 9)).toEqual({ width: 114, height: 64 });
  });
  it("makes a square tile long-edge on both sides", () => {
    expect(tileSize(64, 1)).toEqual({ width: 114, height: 114 });
  });
  it("scales with the requested width", () => {
    expect(tileSize(88, 9 / 16)).toEqual({ width: 88, height: 156 });
  });
});
