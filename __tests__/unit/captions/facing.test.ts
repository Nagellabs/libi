import { describe, it, expect } from "vitest";
import { isOverlayNearEdgeOn, isCaptionNearEdgeOn, captionFacingFraction } from "@/lib/captions/facing";
import { IDENTITY_TRANSFORM3D } from "@/lib/overlays/transform3d";

const T = (rx: number, ry: number) => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: rx, y: ry, z: 0 }, scale: { x: 1, y: 1, z: 1 } });
const D = Math.PI / 180;

describe("captionFacingFraction", () => {
  it("identity faces the camera fully (1)", () => expect(captionFacingFraction(T(0, 0))).toBeCloseTo(1, 5));
  it("90° yaw is edge-on (≈0)", () => expect(captionFacingFraction(T(0, 90 * D))).toBeCloseTo(0, 5));
  it("roll (z) does not reduce facing", () => {
    const t = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 1.2 }, scale: { x: 1, y: 1, z: 1 } };
    expect(captionFacingFraction(t)).toBeCloseTo(1, 5);
  });
  it("isCaptionNearEdgeOn true past ~70° yaw, false near head-on", () => {
    expect(isCaptionNearEdgeOn(T(0, 75 * D))).toBe(true);
    expect(isCaptionNearEdgeOn(T(0, 20 * D))).toBe(false);
  });
});

describe("facing", () => {
  it("identity faces the camera (not edge-on)", () => {
    expect(isOverlayNearEdgeOn(IDENTITY_TRANSFORM3D)).toBe(false);
    expect(captionFacingFraction(IDENTITY_TRANSFORM3D)).toBeCloseTo(1, 6);
  });
  it("near 90° pitch is edge-on", () => {
    const edge = { ...IDENTITY_TRANSFORM3D, rotation: { x: Math.PI / 2 - 0.05, y: 0, z: 0 } };
    expect(isOverlayNearEdgeOn(edge)).toBe(true);
  });
  it("the deprecated alias still works", () => {
    expect(isCaptionNearEdgeOn(IDENTITY_TRANSFORM3D)).toBe(false);
  });
});
