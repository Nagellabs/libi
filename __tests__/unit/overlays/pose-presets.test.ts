import { describe, it, expect } from "vitest";
import {
  POSE_PRESETS,
  applyPosePreset,
  nearestPosePreset,
} from "@/lib/overlays/pose-presets";
import { IDENTITY_TRANSFORM3D } from "@/lib/overlays/transform3d";
import type { Transform3D } from "@/lib/engine/types";

describe("pose-presets", () => {
  it("applyPosePreset sets pitch/yaw and preserves spin and position", () => {
    const base: Transform3D = {
      position: { x: 5, y: 6, z: 7 },
      rotation: { x: 0.1, y: 0.2, z: 1.23 },
    };
    const next = applyPosePreset(base, "ground");
    expect(next.rotation.x).toBeCloseTo(POSE_PRESETS.ground.rotationX, 6);
    expect(next.rotation.y).toBeCloseTo(POSE_PRESETS.ground.rotationY, 6);
    // Spin (z) and position are untouched.
    expect(next.rotation.z).toBe(1.23);
    expect(next.position).toEqual({ x: 5, y: 6, z: 7 });
    // Pure: base is not mutated.
    expect(base.rotation.x).toBe(0.1);
  });

  it("billboard is the identity orientation", () => {
    expect(POSE_PRESETS.billboard).toEqual({ rotationX: 0, rotationY: 0 });
    const next = applyPosePreset(IDENTITY_TRANSFORM3D, "billboard");
    expect(next.rotation).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("nearestPosePreset matches an exactly-applied pose and round-trips every preset", () => {
    for (const preset of Object.keys(POSE_PRESETS) as (keyof typeof POSE_PRESETS)[]) {
      const t = applyPosePreset(IDENTITY_TRANSFORM3D, preset);
      expect(nearestPosePreset(t)).toBe(preset);
    }
  });

  it("nearestPosePreset returns null when orientation is far from every preset", () => {
    const t: Transform3D = {
      ...IDENTITY_TRANSFORM3D,
      rotation: { x: 1.4, y: -1.4, z: 0 },
    };
    expect(nearestPosePreset(t)).toBeNull();
  });
});
