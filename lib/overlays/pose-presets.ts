import type { Transform3D } from "@/lib/engine/types";
import type { CameraPreset } from "@/components/preview/camera-preset-grid";

/**
 * Pose presets — the merged replacement for the old `cameraPreset` grid.
 *
 * The illustrated 5-tile grid (billboard / ground / lowAngle / highAngle /
 * angled) now drives the overlay's `transform3d.rotation` — the SAME thing the
 * three rotation circles edit — instead of repositioning the three.js camera.
 * Each tile snaps pitch (rotation.x) + yaw (rotation.y) to a recognizable pose;
 * the user then fine-tunes via the circles / number inputs. Roll (rotation.z /
 * Spin), position, and scale are preserved — a pose only sets orientation.
 *
 * Pure module: no React, no GL. The angles (radians) are gentle by design so a
 * preset reads as "tilted toward X" rather than spinning the content away.
 */
export interface Pose {
  /** Pitch — rotation.x, radians. */
  rotationX: number;
  /** Yaw — rotation.y, radians. */
  rotationY: number;
}

export const POSE_PRESETS: Record<CameraPreset, Pose> = {
  // Flat, facing the viewer.
  billboard: { rotationX: 0, rotationY: 0 },
  // Laid back toward the floor (the strongest forward pitch).
  ground: { rotationX: 0.55, rotationY: 0 },
  // Tilted up toward the viewer — the heroic low-angle look.
  lowAngle: { rotationX: -0.4, rotationY: 0 },
  // Tilted down — the overhead high-angle look (gentler than `ground`).
  highAngle: { rotationX: 0.32, rotationY: 0 },
  // A 3/4 view — yaw + slight pitch.
  angled: { rotationX: 0.22, rotationY: 0.5 },
};

/** Distance in (pitch, yaw) radian space. Roll is ignored. Pure. */
function poseDistance(t: Transform3D, pose: Pose): number {
  const dx = t.rotation.x - pose.rotationX;
  const dy = t.rotation.y - pose.rotationY;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Return a NEW transform with rotation.x/y snapped to `preset`'s pose; roll
 * (rotation.z), position and scale are preserved. Pure; `t` is not mutated.
 */
export function applyPosePreset(t: Transform3D, preset: CameraPreset): Transform3D {
  const pose = POSE_PRESETS[preset];
  return {
    position: { ...t.position },
    rotation: { x: pose.rotationX, y: pose.rotationY, z: t.rotation.z },
  };
}

/**
 * The preset whose pose is closest to the current orientation, within
 * `withinRad`, else null (so no grid tile is highlighted). Pure.
 */
export function nearestPosePreset(
  t: Transform3D,
  withinRad = 0.2,
): CameraPreset | null {
  let best: CameraPreset | null = null;
  let bestDist = withinRad;
  for (const preset of Object.keys(POSE_PRESETS) as CameraPreset[]) {
    const dist = poseDistance(t, POSE_PRESETS[preset]);
    if (dist <= bestDist) {
      bestDist = dist;
      best = preset;
    }
  }
  return best;
}
