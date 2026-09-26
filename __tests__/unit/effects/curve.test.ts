// A custom effect as numbers (lib/effects/curve.ts): what the worker encodes,
// what the page accepts from it, and how accurately the page interpolates.
import { describe, expect, it } from "vitest";
import { easeOutBack } from "@/lib/engine/animation";
import { CURVE_FIELDS, CURVE_SAMPLES, curveKey, encodeDelta, interpolateCurve, sanitizeCurve } from "@/lib/effects/curve";
import type { TransformDelta } from "@/lib/effects/types";

/** What the sandbox worker would send for `animate`, sanitized as the page accepts it. */
function sampled(animate: (p: number) => unknown, samples = CURVE_SAMPLES): Float64Array {
  const out = new Float64Array(CURVE_FIELDS.length * samples);
  for (let i = 0; i < samples; i++) encodeDelta(animate(i / (samples - 1)), out, i, samples);
  const clean = sanitizeCurve(out.buffer, samples);
  expect(clean).not.toBeNull();
  return clean!;
}

describe("curve interpolation accuracy", () => {
  it("tracks a smooth ease (500 px easeOutBack, rotation, opacity) to well under a hundredth of a pixel, everywhere", () => {
    const exact = (p: number): TransformDelta => ({ dx: -500 * (1 - easeOutBack(p)), rotateDeg: 90 * (1 - p) * (1 - p), opacity: Math.min(1, p * 1.5) });
    const curve = sampled(exact);
    let worst = 0;
    for (let k = 0; k <= 10_000; k++) {
      const p = k / 10_000;
      const got = interpolateCurve(curve, CURVE_SAMPLES, p);
      const want = exact(p);
      worst = Math.max(worst, Math.abs(got.dx! - want.dx!), Math.abs(got.rotateDeg! - want.rotateDeg!));
      // opacity has a kink at 2/3: linear pieces interpolate exactly except within one interval of it
      if (Math.abs(p - 2 / 3) > 1 / 1024) expect(Math.abs(got.opacity! - want.opacity!)).toBeLessThan(1e-9);
    }
    expect(worst).toBeLessThan(0.01);
  });

  it("is exact at every sample point, and clamps progress outside 0..1 (and NaN to 0)", () => {
    const curve = sampled((p) => ({ dy: p * 1000 }));
    for (const i of [0, 1, 512, 1023, 1024]) expect(interpolateCurve(curve, CURVE_SAMPLES, i / 1024).dy).toBeCloseTo(i * (1000 / 1024), 9);
    expect(interpolateCurve(curve, CURVE_SAMPLES, -3).dy).toBe(0);
    expect(interpolateCurve(curve, CURVE_SAMPLES, 7).dy).toBe(1000);
    expect(interpolateCurve(curve, CURVE_SAMPLES, Number.NaN).dy).toBe(0);
  });

  it("takes the NEAREST sample for a discrete step, a field that appears or disappears, and the clip edge", () => {
    const curve = sampled((p) => (p < 0.5 ? { clipReveal: { edge: "left", fraction: p } } : { scale: 2, clipReveal: { edge: "top", fraction: p } }));
    const before = interpolateCurve(curve, CURVE_SAMPLES, 0.25);
    expect(before.scale).toBeUndefined();
    expect(before.clipReveal).toEqual({ edge: "left", fraction: expect.closeTo(0.25, 6) });
    const after = interpolateCurve(curve, CURVE_SAMPLES, 0.75);
    expect(after.scale).toBe(2);
    expect(after.clipReveal).toEqual({ edge: "top", fraction: expect.closeTo(0.75, 6) });
  });

  it("an identity animate is identity everywhere", () => {
    const curve = sampled(() => ({}));
    for (const p of [0, 0.3, 1]) expect(interpolateCurve(curve, CURVE_SAMPLES, p)).toEqual({});
  });
});

describe("the page accepts only sane numbers (sanitizeCurve)", () => {
  it("drops non-finite values to 'absent' (identity) and clamps huge ones", () => {
    const curve = sampled((p) =>
      p < 0.5
        ? { dx: Number.NaN, dy: Number.POSITIVE_INFINITY, scale: Number.NEGATIVE_INFINITY, opacity: 7, blurPx: -3, rotateDeg: 1e300 }
        : { dx: "12" as unknown as number, scaleX: 1e9, clipReveal: { edge: "diagonal", fraction: 0.5 } },
    );
    const early = interpolateCurve(curve, CURVE_SAMPLES, 0.1);
    expect(early.dx).toBeUndefined();
    expect(early.dy).toBeUndefined();
    expect(early.scale).toBeUndefined();
    expect(early.opacity).toBe(1);
    expect(early.blurPx).toBe(0);
    expect(early.rotateDeg).toBe(100_000);
    const late = interpolateCurve(curve, CURVE_SAMPLES, 0.9);
    expect(late.dx).toBeUndefined(); // a string is not a number
    expect(late.scaleX).toBe(1_000);
    expect(late.clipReveal).toBeUndefined(); // not one of the four edges
    for (const v of Object.values(late)) if (typeof v === "number") expect(Number.isFinite(v)).toBe(true);
  });

  it("refuses a table of the wrong size, the wrong type, or an absurd sample count", () => {
    const ok = new Float64Array(CURVE_FIELDS.length * 5).buffer;
    expect(sanitizeCurve(ok, 5)).not.toBeNull();
    expect(sanitizeCurve(ok, 6)).toBeNull();
    expect(sanitizeCurve(new Float64Array(3).buffer, 5)).toBeNull();
    expect(sanitizeCurve(new Float64Array(CURVE_FIELDS.length * 5), 5)).toBeNull(); // a view, not the buffer
    expect(sanitizeCurve({ byteLength: 400 }, 5)).toBeNull();
    expect(sanitizeCurve(new Float64Array(CURVE_FIELDS.length).buffer, 1)).toBeNull();
    expect(sanitizeCurve(new Float64Array(CURVE_FIELDS.length * 5000).buffer, 5000)).toBeNull();
  });

  it("an edge value that is not exactly 1..4 is absent", () => {
    const samples = 2;
    const raw = new Float64Array(CURVE_FIELDS.length * samples).fill(Number.NaN);
    const edge = CURVE_FIELDS.indexOf("clipEdge");
    const frac = CURVE_FIELDS.indexOf("clipFraction");
    raw[edge * samples] = 2.5;
    raw[edge * samples + 1] = 5;
    raw[frac * samples] = 0.5;
    raw[frac * samples + 1] = 0.5;
    const c = sanitizeCurve(raw.buffer, samples)!;
    expect(interpolateCurve(c, samples, 0).clipReveal).toBeUndefined();
    expect(interpolateCurve(c, samples, 1).clipReveal).toBeUndefined();
  });
});

describe("curveKey", () => {
  it("is one key per (effect, source, params), whatever order the params come in", () => {
    const h = "a".repeat(64);
    expect(curveKey("fx", h, { a: 1, b: "x" })).toBe(curveKey("fx", h, { b: "x", a: 1 }));
    expect(curveKey("fx", h, { a: 1 })).not.toBe(curveKey("fx", h, { a: 2 }));
    expect(curveKey("fx", h, {})).not.toBe(curveKey("fx", "b".repeat(64), {}));
    expect(curveKey("fx", h, {})).not.toBe(curveKey("fy", h, {}));
  });
});
