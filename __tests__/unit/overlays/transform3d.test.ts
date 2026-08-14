import { describe, it, expect } from "vitest";
import {
  IDENTITY_TRANSFORM3D,
  isIdentityTransform3d,
  degToRadVec3,
  radToDegVec3,
  applyOrbitDrag,
  withPosition,
  withRotation,
} from "@/lib/overlays/transform3d";
import type { Transform3D } from "@/lib/engine/types";

const EPS = 1e-6;

describe("IDENTITY_TRANSFORM3D", () => {
  it("has only position and rotation (no scale)", () => {
    expect(IDENTITY_TRANSFORM3D).toEqual({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    });
    expect(Object.keys(IDENTITY_TRANSFORM3D)).not.toContain("scale");
  });
});

describe("isIdentityTransform3d", () => {
  it("is true for the identity", () => {
    expect(isIdentityTransform3d(IDENTITY_TRANSFORM3D)).toBe(true);
    expect(
      isIdentityTransform3d({
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
      }),
    ).toBe(true);
  });

  it("is false when position differs", () => {
    expect(
      isIdentityTransform3d({ ...IDENTITY_TRANSFORM3D, position: { x: 1, y: 0, z: 0 } }),
    ).toBe(false);
  });

  it("is false when rotation differs", () => {
    expect(
      isIdentityTransform3d({ ...IDENTITY_TRANSFORM3D, rotation: { x: 0, y: 0.1, z: 0 } }),
    ).toBe(false);
  });
});

describe("degToRadVec3 / radToDegVec3", () => {
  it("converts 90 degrees to ~1.5708 rad", () => {
    const r = degToRadVec3({ x: 90, y: 0, z: 180 });
    expect(r.x).toBeCloseTo(Math.PI / 2, 6);
    expect(r.y).toBe(0);
    expect(r.z).toBeCloseTo(Math.PI, 6);
  });

  it("round-trips deg -> rad -> deg", () => {
    const deg = { x: 90, y: 45, z: -30 };
    const back = radToDegVec3(degToRadVec3(deg));
    expect(back.x).toBeCloseTo(90, 6);
    expect(back.y).toBeCloseTo(45, 6);
    expect(back.z).toBeCloseTo(-30, 6);
  });
});

describe("applyOrbitDrag", () => {
  it("derives yaw from dx and pitch from dy", () => {
    const out = applyOrbitDrag(IDENTITY_TRANSFORM3D, 10, 20, 0.01);
    expect(out.rotation.y).toBeCloseTo(0.1, 6);
    expect(out.rotation.x).toBeCloseTo(0.2, 6);
    expect(out.rotation.z).toBe(0);
  });

  it("leaves position untouched and does not add a scale key", () => {
    const base: Transform3D = {
      position: { x: 5, y: 6, z: 7 },
      rotation: { x: 0, y: 0, z: 0 },
    };
    const out = applyOrbitDrag(base, 3, 4);
    expect(out.position).toEqual(base.position);
    expect(Object.keys(out)).not.toContain("scale");
  });

  it("does not mutate the base transform", () => {
    const base: Transform3D = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    };
    const snapshot = JSON.parse(JSON.stringify(base));
    applyOrbitDrag(base, 100, 100);
    expect(base).toEqual(snapshot);
  });

  it("wraps the angle into [-PI, PI] when dragging past PI", () => {
    // start near +PI, push further -> wraps to negative
    const base: Transform3D = {
      ...IDENTITY_TRANSFORM3D,
      rotation: { x: 0, y: Math.PI - 0.05, z: 0 },
    };
    // dx so that y increases by 0.2 -> Math.PI + 0.15, should wrap to ~-(PI - 0.15)
    const out = applyOrbitDrag(base, 20, 0, 0.01);
    expect(out.rotation.y).toBeGreaterThanOrEqual(-Math.PI);
    expect(out.rotation.y).toBeLessThanOrEqual(Math.PI);
    expect(out.rotation.y).toBeCloseTo(-(Math.PI - 0.15), 6);
  });
});

describe("immutable single-axis setters", () => {
  const base: Transform3D = {
    position: { x: 1, y: 2, z: 3 },
    rotation: { x: 4, y: 5, z: 6 },
  };

  it("withPosition changes only the target axis", () => {
    const out = withPosition(base, "y", 99);
    expect(out.position).toEqual({ x: 1, y: 99, z: 3 });
    expect(out.rotation).toEqual(base.rotation);
    expect(Object.keys(out)).not.toContain("scale");
    expect(base.position.y).toBe(2); // original unchanged
  });

  it("withRotation changes only the target axis", () => {
    const out = withRotation(base, "z", 99);
    expect(out.rotation).toEqual({ x: 4, y: 5, z: 99 });
    expect(out.position).toEqual(base.position);
    expect(Object.keys(out)).not.toContain("scale");
    expect(base.rotation.z).toBe(6);
  });
});

import { snapAngleToDetents, clampDepth, clampDepthForKind, DEPTH_LIMIT_WORLD, DEPTH_LIMIT_PX } from "@/lib/overlays/transform3d";

describe("snapAngleToDetents", () => {
  const D = (deg: number) => (deg * Math.PI) / 180;
  it("snaps a near-zero angle to exactly 0", () => {
    expect(snapAngleToDetents(D(2.5))).toBeCloseTo(0, 6);
    expect(snapAngleToDetents(D(-3))).toBeCloseTo(0, 6);
  });
  it("snaps near ±45 / ±90 to the exact detent", () => {
    expect(snapAngleToDetents(D(46))).toBeCloseTo(D(45), 6);
    expect(snapAngleToDetents(D(-88))).toBeCloseTo(D(-90), 6);
  });
  it("leaves an angle outside the threshold unchanged", () => {
    expect(snapAngleToDetents(D(20))).toBeCloseTo(D(20), 6);
  });
  it("honors a custom threshold of 0 (never snaps)", () => {
    expect(snapAngleToDetents(D(1), undefined, 0)).toBeCloseTo(D(1), 6);
  });
});

describe("clampDepth", () => {
  it("clamps beyond the visible band", () => {
    expect(clampDepth(5000)).toBe(1800);
    expect(clampDepth(-5000)).toBe(-1800);
  });
  it("passes through values inside the band", () => {
    expect(clampDepth(500)).toBe(500);
    expect(clampDepth(0)).toBe(0);
  });
});

describe("FIX C: clampDepthForKind uses per-kind limits", () => {
  it("three kind clamps at DEPTH_LIMIT_WORLD (world units)", () => {
    expect(clampDepthForKind(DEPTH_LIMIT_WORLD + 1, "three")).toBe(DEPTH_LIMIT_WORLD);
    expect(clampDepthForKind(-(DEPTH_LIMIT_WORLD + 1), "three")).toBe(-DEPTH_LIMIT_WORLD);
    expect(clampDepthForKind(1, "three")).toBe(1);
  });
  it("text kind also clamps at DEPTH_LIMIT_WORLD (3D-text uses world units)", () => {
    expect(clampDepthForKind(DEPTH_LIMIT_WORLD + 0.5, "text")).toBe(DEPTH_LIMIT_WORLD);
    expect(clampDepthForKind(-(DEPTH_LIMIT_WORLD + 0.5), "text")).toBe(-DEPTH_LIMIT_WORLD);
  });
  it("image kind clamps at DEPTH_LIMIT_PX (pixel units)", () => {
    expect(clampDepthForKind(DEPTH_LIMIT_PX + 1, "image")).toBe(DEPTH_LIMIT_PX);
    expect(clampDepthForKind(-(DEPTH_LIMIT_PX + 1), "image")).toBe(-DEPTH_LIMIT_PX);
    expect(clampDepthForKind(100, "image")).toBe(100);
  });
  it("video and code kinds also clamp at DEPTH_LIMIT_PX", () => {
    expect(clampDepthForKind(DEPTH_LIMIT_PX + 1, "video")).toBe(DEPTH_LIMIT_PX);
    expect(clampDepthForKind(DEPTH_LIMIT_PX + 1, "code")).toBe(DEPTH_LIMIT_PX);
  });
  it("DEPTH_LIMIT_WORLD is much smaller than DEPTH_LIMIT_PX (proving world vs px distinction)", () => {
    // DEPTH_LIMIT_WORLD should be ~2 and DEPTH_LIMIT_PX should be ~250 — the
    // kinds must differ in limit, confirming the fix actually disambiguates them.
    expect(DEPTH_LIMIT_WORLD).toBeLessThan(10);
    expect(DEPTH_LIMIT_PX).toBeGreaterThan(10);
  });
});
