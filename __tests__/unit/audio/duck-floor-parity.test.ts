import { describe, it, expect } from "vitest";
import { duckReductionFloor, sanitizeDuck, DEFAULT_DUCK } from "@/lib/audio/duck-params";
import { duckGainCurve } from "@/lib/audio/duck-law";

/**
 * The preview (Web Audio worklet) and the export (ffmpeg) are two independent
 * implementations of the same duck. They drifted once, badly: the export read
 * `reductionDb` as ffmpeg's `makeup` — a LINEAR multiplier, range 1–64 — so a
 * -12 dB duck became a 12x, +21.6 dB BOOST, hard-clipping 10% of every export
 * while the preview sounded correct. These tests pin the two together.
 */

describe("duckReductionFloor", () => {
  it("turns a reduction in dB into a linear floor below 1", () => {
    expect(duckReductionFloor(-12)).toBeCloseTo(0.251189, 6);
    expect(duckReductionFloor(-6)).toBeCloseTo(0.501187, 6);
    expect(duckReductionFloor(-60)).toBeCloseTo(0.001, 6);
  });

  it("is exactly 1 (no ducking) at 0 dB", () => {
    expect(duckReductionFloor(0)).toBe(1);
  });

  it("never returns a BOOST, even if handed a positive value", () => {
    expect(duckReductionFloor(12)).toBe(1);
    expect(duckReductionFloor(60)).toBe(1);
  });

  it("stays within (0, 1] across the whole sanitized range", () => {
    for (let db = -60; db <= 0; db++) {
      const f = duckReductionFloor(db);
      expect(f).toBeGreaterThan(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });
});

describe("the floor is what both engines clamp to", () => {
  it("is the worklet's reductionMin, and the export curve's minimum", () => {
    // Parity of the FULL curve is pinned in duck-law-parity.test.ts, which runs
    // the worklet's own source. Here we only assert the floor both sides share.
    const duck = sanitizeDuck({ ...DEFAULT_DUCK, sidechainClipIds: ["vo"], reductionDb: -12 });
    const loud = new Float32Array(48000).fill(0.5);
    const curve = duckGainCurve(loud, duck, 48000);
    let min = Infinity;
    for (const g of curve) min = Math.min(min, g);
    expect(min).toBeGreaterThanOrEqual(duckReductionFloor(-12) - 1e-6);
    expect(min).toBeLessThan(1);
  });
});
