import { describe, it, expect } from "vitest";
import { ROUGH_SEED, INK, GRAYS } from "@/lib/storyboard/render/sketch-kit";

const HEX = /^#[0-9a-f]{6}$/i;

describe("sketch-kit", () => {
  it("exposes a numeric Rough.js seed", () => {
    expect(typeof ROUGH_SEED).toBe("number");
    expect(Number.isFinite(ROUGH_SEED)).toBe(true);
  });
  it("INK is a valid hex color", () => {
    expect(INK).toMatch(HEX);
  });
  it("GRAYS is a light→dark hex ramp", () => {
    expect(GRAYS.length).toBeGreaterThanOrEqual(4);
    for (const g of GRAYS) expect(g).toMatch(HEX);
    const lum = (h: string) =>
      parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16);
    for (let i = 1; i < GRAYS.length; i++) {
      expect(lum(GRAYS[i])).toBeLessThan(lum(GRAYS[i - 1]));
    }
  });
});
