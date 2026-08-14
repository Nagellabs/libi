import { describe, it, expect } from "vitest";
import {
  applyPitchDrag,
  applyYawDrag,
  applyRollDrag,
  applyDepthDrag,
} from "@/lib/overlays/transform3d";
import type { Transform3D } from "@/lib/engine/types";

function makeBase(): Transform3D {
  return {
    position: { x: 3, y: -7, z: 11 },
    rotation: { x: 0.2, y: -0.3, z: 0.4 },
  };
}

const TWO_PI = Math.PI * 2;

describe("applyPitchDrag", () => {
  it("moves ONLY rotation.x", () => {
    const base = makeBase();
    const out = applyPitchDrag(base, 50);
    expect(out.rotation.x).not.toBe(base.rotation.x);
    // everything else byte-equal
    expect(out.rotation.y).toBe(base.rotation.y);
    expect(out.rotation.z).toBe(base.rotation.z);
    expect(out.position).toEqual(base.position);
  });

  it("zero delta → identity", () => {
    const base = makeBase();
    const out = applyPitchDrag(base, 0);
    // target axis passes through wrap() → equal within fp epsilon
    expect(out.rotation.x).toBeCloseTo(base.rotation.x, 12);
    // untouched axes are byte-equal
    expect(out.rotation.y).toBe(base.rotation.y);
    expect(out.rotation.z).toBe(base.rotation.z);
    expect(out.position).toEqual(base.position);
  });

  it("wraps into [-PI, PI] for a large delta", () => {
    const base = makeBase();
    // huge delta → many rotations; result must be wrapped
    const out = applyPitchDrag(base, 100000, 0.01);
    expect(out.rotation.x).toBeGreaterThanOrEqual(-Math.PI);
    expect(out.rotation.x).toBeLessThanOrEqual(Math.PI);
    // and it should still be congruent to base + delta mod 2pi
    const raw = base.rotation.x + 100000 * 0.01;
    const diff = (((out.rotation.x - raw) % TWO_PI) + TWO_PI) % TWO_PI;
    expect(Math.min(diff, TWO_PI - diff)).toBeLessThan(1e-6);
  });

  it("does not alias base.rotation/base.position", () => {
    const base = makeBase();
    const out = applyPitchDrag(base, 50);
    out.rotation.x = 999;
    out.position.x = 999;
    expect(base.rotation.x).toBe(0.2);
    expect(base.position.x).toBe(3);
  });
});

describe("applyYawDrag", () => {
  it("moves ONLY rotation.y", () => {
    const base = makeBase();
    const out = applyYawDrag(base, 50);
    expect(out.rotation.y).not.toBe(base.rotation.y);
    expect(out.rotation.x).toBe(base.rotation.x);
    expect(out.rotation.z).toBe(base.rotation.z);
    expect(out.position).toEqual(base.position);
  });

  it("zero delta → identity", () => {
    const base = makeBase();
    const out = applyYawDrag(base, 0);
    expect(out.rotation.y).toBeCloseTo(base.rotation.y, 12);
    expect(out.rotation.x).toBe(base.rotation.x);
    expect(out.rotation.z).toBe(base.rotation.z);
    expect(out.position).toEqual(base.position);
  });

  it("wraps into [-PI, PI] for a large delta", () => {
    const base = makeBase();
    const out = applyYawDrag(base, -100000, 0.01);
    expect(out.rotation.y).toBeGreaterThanOrEqual(-Math.PI);
    expect(out.rotation.y).toBeLessThanOrEqual(Math.PI);
  });

  it("does not alias base", () => {
    const base = makeBase();
    const out = applyYawDrag(base, 50);
    out.rotation.y = 999;
    expect(base.rotation.y).toBe(-0.3);
  });
});

describe("applyRollDrag", () => {
  it("moves ONLY rotation.z", () => {
    const base = makeBase();
    const out = applyRollDrag(base, 50);
    expect(out.rotation.z).not.toBe(base.rotation.z);
    expect(out.rotation.x).toBe(base.rotation.x);
    expect(out.rotation.y).toBe(base.rotation.y);
    expect(out.position).toEqual(base.position);
  });

  it("zero delta → identity", () => {
    const base = makeBase();
    const out = applyRollDrag(base, 0);
    expect(out.rotation.z).toBeCloseTo(base.rotation.z, 12);
    expect(out.rotation.x).toBe(base.rotation.x);
    expect(out.rotation.y).toBe(base.rotation.y);
    expect(out.position).toEqual(base.position);
  });

  it("wraps into [-PI, PI] for a large delta", () => {
    const base = makeBase();
    const out = applyRollDrag(base, 100000, 0.01);
    expect(out.rotation.z).toBeGreaterThanOrEqual(-Math.PI);
    expect(out.rotation.z).toBeLessThanOrEqual(Math.PI);
  });

  it("does not alias base", () => {
    const base = makeBase();
    const out = applyRollDrag(base, 50);
    out.rotation.z = 999;
    expect(base.rotation.z).toBe(0.4);
  });
});

describe("applyDepthDrag", () => {
  it("moves ONLY position.z", () => {
    const base = makeBase();
    const out = applyDepthDrag(base, 50);
    expect(out.position.z).not.toBe(base.position.z);
    expect(out.position.x).toBe(base.position.x);
    expect(out.position.y).toBe(base.position.y);
    expect(out.rotation).toEqual(base.rotation);
  });

  it("zero delta → identity", () => {
    const base = makeBase();
    expect(applyDepthDrag(base, 0)).toEqual(base);
  });

  it("is unbounded (large delta → large position.z, no wrap)", () => {
    const base = makeBase();
    const out = applyDepthDrag(base, 100000, 0.5);
    expect(out.position.z).toBe(base.position.z + 100000 * 0.5);
    // far outside [-PI, PI] — proves no wrapping
    expect(out.position.z).toBeGreaterThan(Math.PI);
  });

  it("uses the default sensitivity of 0.5", () => {
    const base = makeBase();
    const out = applyDepthDrag(base, 100);
    expect(out.position.z).toBe(base.position.z + 100 * 0.5);
  });

  it("does not alias base.position", () => {
    const base = makeBase();
    const out = applyDepthDrag(base, 50);
    out.position.z = 999;
    out.rotation.x = 999;
    expect(base.position.z).toBe(11);
    expect(base.rotation.x).toBe(0.2);
  });
});
