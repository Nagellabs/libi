import { describe, it, expect } from "vitest";
import {
  projectSpatialQuadCorners,
  projectSpatialQuadFootprint,
  projectSpatialQuadBboxUnclamped,
  quadCenter,
  pointInQuad,
  type QuadRect,
} from "@/lib/engine/overlay-quad-projection";
import { IDENTITY_TRANSFORM3D } from "@/lib/overlays/transform3d";
import type { Transform3D } from "@/lib/engine/types";

const rect: QuadRect = { x: 100, y: 200, width: 800, height: 400 };

const NO_FLIP = { flipH: false, flipV: false };

function t(over: Partial<Transform3D> = {}): Transform3D {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    ...over,
  };
}

describe("projectSpatialQuadCorners", () => {
  it("identity transform projects to the rect's own corners (planar continuity)", () => {
    const [tl, tr, br, bl] = projectSpatialQuadCorners(rect, IDENTITY_TRANSFORM3D, NO_FLIP);
    expect(tl.x).toBeCloseTo(rect.x, 4);
    expect(tl.y).toBeCloseTo(rect.y, 4);
    expect(tr.x).toBeCloseTo(rect.x + rect.width, 4);
    expect(tr.y).toBeCloseTo(rect.y, 4);
    expect(br.x).toBeCloseTo(rect.x + rect.width, 4);
    expect(br.y).toBeCloseTo(rect.y + rect.height, 4);
    expect(bl.x).toBeCloseTo(rect.x, 4);
    expect(bl.y).toBeCloseTo(rect.y + rect.height, 4);
  });

  it("pure yaw keeps the rect center covered (near-plane-clipped footprint)", () => {
    // Pure yaw (Angle / rotation.y) rotates about the rect's vertical centerline.
    // Using the clipped footprint, the rect center is still covered.
    const fp = projectSpatialQuadFootprint(rect, t({ rotation: { x: 0, y: 1.2, z: 0 } }), NO_FLIP);
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    expect(pointInQuad(center, fp.polygon)).toBe(true);
  });

  it("treats position as PIXELS (continuous with the planar path), not normalized units", () => {
    // A 40px downward position offset must move the projected center ~40px down
    // — NOT half the frame (the pre-fix bug divided by the world plane height).
    const moved = projectSpatialQuadCorners(rect, t({ position: { x: 0, y: 40, z: 0 } }), NO_FLIP);
    const c = quadCenter(moved);
    expect(c.x).toBeCloseTo(rect.x + rect.width / 2, 0);
    expect(c.y).toBeCloseTo(rect.y + rect.height / 2 + 40, 0);
  });

  it("a 90° spin (rotation.z) swaps the projected aspect about the center", () => {
    const corners = projectSpatialQuadCorners(rect, t({ rotation: { x: 0, y: 0, z: Math.PI / 2 } }), NO_FLIP);
    const c = quadCenter(corners);
    // Center unchanged.
    expect(c.x).toBeCloseTo(rect.x + rect.width / 2, 1);
    expect(c.y).toBeCloseTo(rect.y + rect.height / 2, 1);
    // The projected bbox width should now be ~the original HEIGHT (spun on Z).
    const xs = corners.map((p) => p.x);
    const projW = Math.max(...xs) - Math.min(...xs);
    expect(projW).toBeGreaterThan(rect.width * 0.4);
    expect(projW).toBeLessThan(rect.width * 0.75);
  });

  it("flipH at identity rotation mirrors corners left↔right (x-offsets from center reverse)", () => {
    // With no flip, corners are [TL, TR, BR, BL] → TL is to the LEFT, TR is to the RIGHT.
    const [tl, tr] = projectSpatialQuadCorners(rect, IDENTITY_TRANSFORM3D, NO_FLIP);
    // With flipH, the x-offsets from center should negate — so TL's x becomes TR's x and vice versa.
    const [tlF, trF] = projectSpatialQuadCorners(rect, IDENTITY_TRANSFORM3D, { flipH: true, flipV: false });

    const cx = rect.x + rect.width / 2;
    // Without flip: tl is left of center (negative offset), tr is right.
    expect(tl.x).toBeLessThan(cx);
    expect(tr.x).toBeGreaterThan(cx);
    // With flipH: tl should now be to the RIGHT (positive offset from center)
    // and tr should be to the LEFT — x-offsets are negated.
    expect(tlF.x).toBeCloseTo(cx + (cx - tl.x), 4); // tl.x flipped = cx + (cx - tl.x)
    expect(trF.x).toBeCloseTo(cx - (tr.x - cx), 4); // tr.x flipped = cx - (tr.x - cx)
    // Vertical positions are unchanged.
    expect(tlF.y).toBeCloseTo(tl.y, 4);
    expect(trF.y).toBeCloseTo(tr.y, 4);
  });
});

describe("projectSpatialQuadBboxUnclamped", () => {
  it("identity transform ⇒ bbox ≈ the input rect (x/y/width/height each within 1px)", () => {
    const bbox = projectSpatialQuadBboxUnclamped(rect, IDENTITY_TRANSFORM3D, NO_FLIP);
    expect(bbox.x).toBeCloseTo(rect.x, 0);
    expect(bbox.y).toBeCloseTo(rect.y, 0);
    expect(bbox.width).toBeCloseTo(rect.width, 0);
    expect(bbox.height).toBeCloseTo(rect.height, 0);
  });

  it("yaw tilt ⇒ bbox width >= rect.width (perspective foreshortening widens the unclamped footprint)", () => {
    // A yaw of 0.6 rad tilts the plane; the near side projects wider than the base rect.
    // Crucially, the UNCLAMPED version can report overflow beyond the rect — unlike
    // projectSpatialQuadFootprint which clips to the rect boundary.
    const bbox = projectSpatialQuadBboxUnclamped(rect, t({ rotation: { x: 0, y: 0.6, z: 0 } }), NO_FLIP);
    // The unclamped bbox should be at least as wide as the base rect.
    expect(bbox.width).toBeGreaterThanOrEqual(rect.width);
  });
});

describe("pointInQuad", () => {
  it("the rect center is inside the identity quad; a far point is outside", () => {
    const corners = projectSpatialQuadCorners(rect, IDENTITY_TRANSFORM3D, NO_FLIP);
    expect(pointInQuad({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, corners)).toBe(true);
    expect(pointInQuad({ x: rect.x - 50, y: rect.y - 50 }, corners)).toBe(false);
  });

  it("follows the tilted quad: center covered, far-flat points excluded", () => {
    const fp = projectSpatialQuadFootprint(rect, t({ rotation: { x: 0, y: 1.4, z: 0 } }), NO_FLIP);
    expect(pointInQuad({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, fp.polygon)).toBe(true);
    // A point well outside the rect is outside the quad too.
    expect(pointInQuad({ x: rect.x - 300, y: rect.y + rect.height / 2 }, fp.polygon)).toBe(false);
  });
});

describe("projectSpatialQuadFootprint", () => {
  it("identity ⇒ bbox equals the rect, polygon is the 4 rect corners", () => {
    const fp = projectSpatialQuadFootprint(rect, IDENTITY_TRANSFORM3D, NO_FLIP);
    expect(fp.bbox.x).toBeCloseTo(rect.x, 3);
    expect(fp.bbox.y).toBeCloseTo(rect.y, 3);
    expect(fp.bbox.width).toBeCloseTo(rect.width, 3);
    expect(fp.bbox.height).toBeCloseTo(rect.height, 3);
    expect(fp.polygon.length).toBe(4);
  });

  it("stays finite (no perspective blow-up) when a corner swings toward the camera", () => {
    const fp = projectSpatialQuadFootprint(rect, t({ rotation: { x: 0, y: 1.45, z: 0 } }), NO_FLIP);
    for (const p of fp.polygon) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      // Bounded to a sane multiple of the rect — never the ±2000px blow-up.
      expect(Math.abs(p.x - (rect.x + rect.width / 2))).toBeLessThan(rect.width * 4);
    }
  });

  it("degenerate (fully behind camera) ⇒ empty polygon, rect bbox fallback", () => {
    // Push the plane far behind the camera via a large +z position (pixels).
    const fp = projectSpatialQuadFootprint(rect, t({ position: { x: 0, y: 0, z: 100000 } }), NO_FLIP);
    expect(fp.polygon.length).toBe(0);
    expect(fp.bbox).toEqual(rect);
  });
});
