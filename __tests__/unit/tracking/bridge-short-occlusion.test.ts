import { describe, it, expect } from "vitest";
import {
  bridgeShortOcclusions,
  SHORT_OCCLUSION_MAX_SEC,
} from "@/lib/tracking/bridge-short-occlusion";
import type { TrackSample } from "@/lib/tracking/types";

function v(t: number, x: number, y = 0, w = 100, h = 100): TrackSample {
  return { t, x, y, w, h, confidence: 1, visible: true };
}
function gap(t: number): TrackSample {
  return { t, x: 0, y: 0, w: 0, h: 0, confidence: 0, visible: false };
}

describe("bridgeShortOcclusions", () => {
  it("bridges a short gap between two consistent visible runs (honest: confidence 0)", () => {
    // 3 invisible frames (~0.1s @ ~30fps spacing) between same-subject boxes
    const samples = [
      v(3.4, 200), gap(3.5), gap(3.6), gap(3.7), v(3.8, 210),
    ];
    const out = bridgeShortOcclusions(samples);
    const mid = out.filter((s) => s.t >= 3.5 && s.t <= 3.7);
    expect(mid.every((s) => s.visible)).toBe(true);
    expect(mid.every((s) => s.confidence === 0)).toBe(true);
    expect(mid.every((s) => (s.targetSim ?? null) === null)).toBe(true);
    // interpolated x is between the bracketing boxes
    const at36 = out.find((s) => s.t === 3.6)!;
    expect(at36.x).toBeGreaterThan(200);
    expect(at36.x).toBeLessThan(210);
  });

  it("does NOT bridge a gap longer than the max", () => {
    const samples = [
      v(0, 200),
      gap(0.2), gap(0.4), gap(0.6), gap(0.8), gap(1.0), // ~1s gap
      v(1.2, 205),
    ];
    const out = bridgeShortOcclusions(samples);
    expect(out.filter((s) => !s.visible).length).toBe(5);
  });

  it("does NOT bridge when the bracketing boxes are a different subject (big jump)", () => {
    const samples = [
      v(3.4, 100, 100, 80, 80),
      gap(3.5), gap(3.6),
      v(3.7, 900, 700, 80, 80), // far away → not the same subject
    ];
    const out = bridgeShortOcclusions(samples);
    expect(out.filter((s) => !s.visible).length).toBe(2);
  });

  it("does NOT bridge when sizes are wildly inconsistent across the gap", () => {
    const samples = [
      v(3.4, 200, 200, 60, 60),
      gap(3.5),
      v(3.6, 205, 205, 600, 600), // 10x bigger → not the same subject
    ];
    const out = bridgeShortOcclusions(samples);
    expect(out.find((s) => s.t === 3.5)!.visible).toBe(false);
  });

  it("leaves a leading/trailing gap (no bracket) untouched", () => {
    const samples = [gap(0), gap(0.1), v(0.2, 200), gap(0.3)];
    const out = bridgeShortOcclusions(samples);
    expect(out.find((s) => s.t === 0)!.visible).toBe(false);
    expect(out.find((s) => s.t === 0.3)!.visible).toBe(false);
  });

  it("is pure and a no-op when there are no gaps", () => {
    const samples = [v(0, 1), v(0.1, 2), v(0.2, 3)];
    const snapshot = JSON.stringify(samples);
    const out = bridgeShortOcclusions(samples);
    expect(out.every((s) => s.visible)).toBe(true);
    expect(JSON.stringify(samples)).toBe(snapshot); // inputs not mutated
  });

  it("exports a sane default max (0.4s)", () => {
    expect(SHORT_OCCLUSION_MAX_SEC).toBe(0.4);
  });

  it("bridges the observed ~0.4s cameraman-pass outage", () => {
    // Mirrors the real lisa12 flicker: good box at 3.41, 3 no-detect
    // frames, good box at 3.81 (same subject, ~same place/size).
    const samples = [
      v(3.41, 230, 200, 90, 110),
      gap(3.51), gap(3.61), gap(3.71),
      v(3.81, 240, 205, 95, 108),
    ];
    const out = bridgeShortOcclusions(samples);
    expect(out.filter((s) => s.t > 3.41 && s.t < 3.81).every((s) => s.visible))
      .toBe(true);
  });
});
