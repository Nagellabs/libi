import type { Transform3D } from "@/lib/engine/types";

/** A named orientation pose (pitch = rotation.x, yaw = rotation.y), radians.
 *  Gentle by design — the common case is subtle tilts. */
export interface OrientationTarget {
  rotationX: number;
  rotationY: number;
}

export const ORIENTATION_TARGET_IDS = [
  "face-camera",
  "ground",
  "lean-left",
  "lean-right",
  "angled",
] as const;

export type OrientationTargetId = (typeof ORIENTATION_TARGET_IDS)[number];

export const ORIENTATION_TARGETS: Record<OrientationTargetId, OrientationTarget> = {
  "face-camera": { rotationX: 0, rotationY: 0 },
  ground: { rotationX: 0.5, rotationY: 0 },
  "lean-left": { rotationX: 0, rotationY: -0.45 },
  "lean-right": { rotationX: 0, rotationY: 0.45 },
  angled: { rotationX: 0.35, rotationY: 0.45 },
};

/** Euclidean distance in (pitch, yaw) radian space. Roll is ignored (it never
 *  hides the layer). Pure. */
export function angularDistance(t: Transform3D, target: OrientationTarget): number {
  const dx = t.rotation.x - target.rotationX;
  const dy = t.rotation.y - target.rotationY;
  return Math.sqrt(dx * dx + dy * dy);
}

/** The closest target within `withinRad` of the current orientation, else null.
 *  Pure. */
export function nearestTarget(
  t: Transform3D,
  withinRad = 0.25,
): OrientationTargetId | null {
  let best: OrientationTargetId | null = null;
  let bestDist = withinRad;
  for (const id of ORIENTATION_TARGET_IDS) {
    const dist = angularDistance(t, ORIENTATION_TARGETS[id]);
    if (dist <= bestDist) {
      bestDist = dist;
      best = id;
    }
  }
  return best;
}

/** Return a NEW transform snapped to `id`'s pitch/yaw, preserving roll (z)
 *  and position. Pure; `t` is not mutated. */
export function applyTarget(t: Transform3D, id: OrientationTargetId): Transform3D {
  const target = ORIENTATION_TARGETS[id];
  return {
    position: { ...t.position },
    rotation: { x: target.rotationX, y: target.rotationY, z: t.rotation.z },
  };
}
