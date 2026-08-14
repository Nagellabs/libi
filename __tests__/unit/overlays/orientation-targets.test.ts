import { describe, it, expect } from "vitest";
import {
  ORIENTATION_TARGETS,
  ORIENTATION_TARGET_IDS,
  nearestTarget,
  applyTarget,
  angularDistance,
} from "@/lib/overlays/orientation-targets";
import { IDENTITY_TRANSFORM3D } from "@/lib/overlays/transform3d";

const t = (x: number, y: number) => ({
  position: { x: 0, y: 0, z: 7 },
  rotation: { x, y, z: 0.5 },
});

describe("orientation-targets", () => {
  it("exposes the five target ids", () => {
    expect(ORIENTATION_TARGET_IDS).toEqual([
      "face-camera",
      "ground",
      "lean-left",
      "lean-right",
      "angled",
    ]);
  });

  it("nearestTarget returns face-camera at the identity", () => {
    expect(nearestTarget(IDENTITY_TRANSFORM3D)).toBe("face-camera");
  });

  it("nearestTarget snaps to lean-right when close", () => {
    const lr = ORIENTATION_TARGETS["lean-right"];
    expect(nearestTarget(t(lr.rotationX + 0.02, lr.rotationY - 0.02))).toBe("lean-right");
  });

  it("nearestTarget returns null when far from every target", () => {
    expect(nearestTarget(t(1.4, 1.4))).toBeNull();
  });

  it("applyTarget writes the pose pitch/yaw and preserves roll/position", () => {
    const out = applyTarget(t(0.9, -0.9), "ground");
    const g = ORIENTATION_TARGETS["ground"];
    expect(out.rotation.x).toBeCloseTo(g.rotationX, 6);
    expect(out.rotation.y).toBeCloseTo(g.rotationY, 6);
    expect(out.rotation.z).toBeCloseTo(0.5, 6);
    expect(out.position.z).toBe(7);
  });

  it("angularDistance is zero at the target and grows monotonically", () => {
    const fc = ORIENTATION_TARGETS["face-camera"];
    expect(angularDistance(t(0, 0), fc)).toBeCloseTo(0, 6);
    expect(angularDistance(t(0.3, 0), fc)).toBeGreaterThan(angularDistance(t(0.1, 0), fc));
  });
});
