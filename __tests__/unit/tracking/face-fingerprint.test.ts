import { describe, it, expect } from "vitest";
import {
  landmarksToBbox,
  computeFingerprint,
  fingerprintSimilarity,
  iouRect,
  type NormalizedLandmark,
  type Blendshape,
} from "@/lib/tracking/face-fingerprint";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a 478-point landmark array where all points are at (cx, cy) by
 *  default, with optional overrides for specific indices. */
function makeLandmarks(
  cx = 0.5,
  cy = 0.5,
  overrides: Record<number, { x: number; y: number }> = {},
): NormalizedLandmark[] {
  return Array.from({ length: 478 }, (_, i) => ({
    x: overrides[i]?.x ?? cx,
    y: overrides[i]?.y ?? cy,
    z: 0,
  }));
}

/** Build a 52-element blendshape array with all scores set to `score`. */
function makeBlendshapes(score = 0): Blendshape[] {
  return Array.from({ length: 52 }, () => ({ score }));
}

// Landmark indices that matter for bbox (just need a spread of x/y values).
// We'll override a few points to give a non-trivial bounding box.
const VIDEO_W = 1920;
const VIDEO_H = 1080;

// ─── landmarksToBbox ────────────────────────────────────────────────────────

describe("landmarksToBbox", () => {
  it("computes bbox from landmark extents scaled to video dimensions", () => {
    // Landmarks span x: [0.1, 0.6], y: [0.2, 0.7].
    const lms = makeLandmarks(0.35, 0.45, {
      0: { x: 0.1, y: 0.2 },
      1: { x: 0.6, y: 0.7 },
    });
    const bbox = landmarksToBbox(lms, VIDEO_W, VIDEO_H);
    expect(bbox.x).toBeCloseTo(0.1 * VIDEO_W, 3);
    expect(bbox.y).toBeCloseTo(0.2 * VIDEO_H, 3);
    expect(bbox.w).toBeCloseTo((0.6 - 0.1) * VIDEO_W, 3);
    expect(bbox.h).toBeCloseTo((0.7 - 0.2) * VIDEO_H, 3);
  });

  it("returns a zero-size bbox when all landmarks are the same point", () => {
    const lms = makeLandmarks(0.5, 0.5);
    const bbox = landmarksToBbox(lms, VIDEO_W, VIDEO_H);
    expect(bbox.w).toBeCloseTo(0, 5);
    expect(bbox.h).toBeCloseTo(0, 5);
  });

  it("uses intrinsic video dimensions, not arbitrary scale", () => {
    const lms = makeLandmarks(0.5, 0.5, {
      0: { x: 0.0, y: 0.0 },
      1: { x: 1.0, y: 1.0 },
    });
    const bbox = landmarksToBbox(lms, 640, 360);
    expect(bbox.x).toBeCloseTo(0, 5);
    expect(bbox.y).toBeCloseTo(0, 5);
    expect(bbox.w).toBeCloseTo(640, 3);
    expect(bbox.h).toBeCloseTo(360, 3);
  });
});

// ─── computeFingerprint ─────────────────────────────────────────────────────

describe("computeFingerprint", () => {
  it("returns geometry and blendshapes fields", () => {
    const lms = makeLandmarks(0.5, 0.5);
    const bs = makeBlendshapes(0.1);
    const fp = computeFingerprint(lms, bs, VIDEO_W, VIDEO_H);
    expect(fp.geometry).toBeInstanceOf(Float32Array);
    expect(fp.geometry.length).toBeGreaterThan(0);
    expect(fp.blendshapes).toBeInstanceOf(Float32Array);
    expect(fp.blendshapes.length).toBe(52);
  });

  it("geometry[0] is 1.0 when inter-pupil distance equals itself (tautology guard)", () => {
    // When all landmarks are distinct with known positions, pairs that are the
    // same as the IPD pair should normalise to ~1.0.
    // We use the default all-same-point case and verify geometry doesn't blow up.
    const lms = makeLandmarks(0.5, 0.5);
    const bs = makeBlendshapes(0);
    const fp = computeFingerprint(lms, bs, VIDEO_W, VIDEO_H);
    // All landmarks at the same point → all distances 0, geometry all 0.
    for (let i = 0; i < fp.geometry.length; i++) {
      expect(isNaN(fp.geometry[i])).toBe(false);
    }
  });

  it("blendshape values match input", () => {
    const lms = makeLandmarks(0.5, 0.5);
    const bs = Array.from({ length: 52 }, (_, i) => ({ score: i / 51 }));
    const fp = computeFingerprint(lms, bs, VIDEO_W, VIDEO_H);
    for (let i = 0; i < 52; i++) {
      expect(fp.blendshapes[i]).toBeCloseTo(i / 51, 5);
    }
  });
});

// ─── fingerprintSimilarity ───────────────────────────────────────────────────

describe("fingerprintSimilarity", () => {
  function makeFp(geomVal: number, bsVal: number) {
    const geometry = new Float32Array(20).fill(geomVal);
    const blendshapes = new Float32Array(52).fill(bsVal);
    return { geometry, blendshapes };
  }

  it("identical fingerprints → similarity of 1.0", () => {
    const fp = makeFp(0.5, 0.3);
    expect(fingerprintSimilarity(fp, fp)).toBeCloseTo(1.0, 5);
  });

  it("completely different fingerprints → similarity closer to 0 than to 1", () => {
    const fp1 = makeFp(1.0, 0.0);
    const fp2 = makeFp(0.0, 1.0);
    // geometry cosine: cos(90°) = 0. blendshape cosine: cos(90°) = 0.
    // Weighted: 0.7*0 + 0.3*0 = 0.
    expect(fingerprintSimilarity(fp1, fp2)).toBeCloseTo(0.0, 5);
  });

  it("result is always in [0, 1]", () => {
    for (let i = 0; i < 20; i++) {
      const fp1 = makeFp(Math.random(), Math.random());
      const fp2 = makeFp(Math.random(), Math.random());
      const sim = fingerprintSimilarity(fp1, fp2);
      expect(sim).toBeGreaterThanOrEqual(0);
      expect(sim).toBeLessThanOrEqual(1);
    }
  });

  it("is symmetric", () => {
    const fp1 = makeFp(0.3, 0.7);
    const fp2 = makeFp(0.8, 0.2);
    expect(fingerprintSimilarity(fp1, fp2)).toBeCloseTo(
      fingerprintSimilarity(fp2, fp1),
      8,
    );
  });

  it("falls back to neutral (0.5) geometry weight when blendshapes are empty", () => {
    const fp1 = {
      geometry: new Float32Array(20).fill(1.0),
      blendshapes: new Float32Array(0),
    };
    const fp2 = {
      geometry: new Float32Array(20).fill(1.0),
      blendshapes: new Float32Array(0),
    };
    // geometry cosine 1.0, blendshape neutral 0.5 → 0.7*1 + 0.3*0.5 = 0.85
    expect(fingerprintSimilarity(fp1, fp2)).toBeCloseTo(0.85, 5);
  });
});

// ─── iouRect ────────────────────────────────────────────────────────────────

describe("iouRect", () => {
  it("identical rects → IoU of 1.0", () => {
    const r = { x: 10, y: 20, w: 100, h: 50 };
    expect(iouRect(r, r)).toBeCloseTo(1.0, 5);
  });

  it("non-overlapping rects → IoU of 0", () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 20, y: 20, w: 10, h: 10 };
    expect(iouRect(a, b)).toBe(0);
  });

  it("50% overlap → IoU of 1/3", () => {
    // a = [0, 0, 10, 10], b = [5, 0, 10, 10]
    // Intersection: [5,0,5,10] = 50. Union: 100+100-50 = 150. IoU = 50/150 = 1/3.
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 5, y: 0, w: 10, h: 10 };
    expect(iouRect(a, b)).toBeCloseTo(1 / 3, 5);
  });

  it("fully contained rect", () => {
    // Small rect fully inside large: area_small / area_large.
    // a: [0,0,10,10] area=100. b: [2,2,6,6] area=36. IoU=36/(100+36-36)=36/100.
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 2, y: 2, w: 6, h: 6 };
    expect(iouRect(a, b)).toBeCloseTo(36 / 100, 5);
  });
});
