import type { Transform3D, Vec3 } from "@/lib/engine/types";

/** The identity 3D transform: no translation, no rotation. */
export const IDENTITY_TRANSFORM3D: Transform3D = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
};

function vecIsZero(v: Vec3): boolean {
  return v.x === 0 && v.y === 0 && v.z === 0;
}

/** True only when `t` equals the identity transform. */
export function isIdentityTransform3d(t: Transform3D): boolean {
  return vecIsZero(t.position) && vecIsZero(t.rotation);
}

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** Convert each component from degrees to radians. */
export function degToRadVec3(v: Vec3): Vec3 {
  return { x: v.x * DEG_TO_RAD, y: v.y * DEG_TO_RAD, z: v.z * DEG_TO_RAD };
}

/** Convert each component from radians to degrees. */
export function radToDegVec3(v: Vec3): Vec3 {
  return { x: v.x * RAD_TO_DEG, y: v.y * RAD_TO_DEG, z: v.z * RAD_TO_DEG };
}

/** Wrap an angle (radians) into the range [-PI, PI]. */
function wrap(angle: number): number {
  const twoPi = Math.PI * 2;
  const a = ((angle + Math.PI) % twoPi + twoPi) % twoPi;
  return a - Math.PI;
}

/**
 * Apply an orbit drag to a transform: horizontal drag (dx) drives yaw
 * (rotation.y), vertical drag (dy) drives pitch (rotation.x). Both wrapped
 * into [-PI, PI]. Position is unchanged. Returns a NEW transform;
 * `base` is not mutated.
 */
export function applyOrbitDrag(
  base: Transform3D,
  dxPx: number,
  dyPx: number,
  sensitivity = 0.01,
): Transform3D {
  return {
    position: { ...base.position },
    rotation: {
      x: wrap(base.rotation.x + dyPx * sensitivity),
      y: wrap(base.rotation.y + dxPx * sensitivity),
      z: base.rotation.z,
    },
  };
}

/**
 * Vertical drag → pitch (rotation.x). Wrapped into [-PI, PI]. Only rotation.x
 * changes; position and the other rotation axes are unchanged. Returns a
 * NEW transform; `base` is not mutated.
 */
export function applyPitchDrag(
  base: Transform3D,
  dyPx: number,
  sensitivity = 0.01,
): Transform3D {
  return {
    position: { ...base.position },
    rotation: {
      x: wrap(base.rotation.x + dyPx * sensitivity),
      y: base.rotation.y,
      z: base.rotation.z,
    },
  };
}

/**
 * Horizontal drag → yaw (rotation.y). Wrapped into [-PI, PI]. Only rotation.y
 * changes. Returns a NEW transform; `base` is not mutated.
 */
export function applyYawDrag(
  base: Transform3D,
  dxPx: number,
  sensitivity = 0.01,
): Transform3D {
  return {
    position: { ...base.position },
    rotation: {
      x: base.rotation.x,
      y: wrap(base.rotation.y + dxPx * sensitivity),
      z: base.rotation.z,
    },
  };
}

/**
 * Drag → roll (rotation.z). Wrapped into [-PI, PI]. Only rotation.z changes.
 * Returns a NEW transform; `base` is not mutated.
 */
export function applyRollDrag(
  base: Transform3D,
  dPx: number,
  sensitivity = 0.01,
): Transform3D {
  return {
    position: { ...base.position },
    rotation: {
      x: base.rotation.x,
      y: base.rotation.y,
      z: wrap(base.rotation.z + dPx * sensitivity),
    },
  };
}

/**
 * Vertical drag → depth (position.z), in world units (NOT wrapped — depth is
 * unbounded). Default sensitivity is 0.5 (larger than the radian-based rotation
 * helpers): the inspector exposes `transformPosZ` over a ±2000 world-unit range
 * (`components/preview/three-d-fields.tsx`), so 0.5 maps a ~4000px vertical drag
 * to the full range — a sane 1:2 px→unit feel. Only position.z changes. Returns
 * a NEW transform; `base` is not mutated.
 */
export function applyDepthDrag(
  base: Transform3D,
  dyPx: number,
  sensitivity = 0.5,
): Transform3D {
  return {
    position: {
      x: base.position.x,
      y: base.position.y,
      z: base.position.z + dyPx * sensitivity,
    },
    rotation: { ...base.rotation },
  };
}

type Axis = "x" | "y" | "z";

/** Immutable setter: returns a copy of `t` with `position[axis] = v`. */
export function withPosition(t: Transform3D, axis: Axis, v: number): Transform3D {
  return {
    position: { ...t.position, [axis]: v },
    rotation: { ...t.rotation },
  };
}

/** Immutable setter: returns a copy of `t` with `rotation[axis] = v`. */
export function withRotation(t: Transform3D, axis: Axis, v: number): Transform3D {
  return {
    position: { ...t.position },
    rotation: { ...t.rotation, [axis]: v },
  };
}

/** Default detent grid (radians): 0, ±45, ±90, ±135, ±180. */
const DEFAULT_DETENTS_RAD = [0, 45, 90, 135, 180, -45, -90, -135, -180].map(
  (d) => (d * Math.PI) / 180,
);

/**
 * Snap an angle (radians) to the nearest detent if it is within `thresholdRad`
 * (default ~5°). Otherwise return the angle unchanged. Pass `thresholdRad = 0`
 * (the Alt-bypass path) to disable snapping entirely. Pure.
 */
export function snapAngleToDetents(
  angleRad: number,
  detentsRad: number[] = DEFAULT_DETENTS_RAD,
  thresholdRad = 0.0873,
): number {
  let best = angleRad;
  let bestDist = thresholdRad;
  for (const d of detentsRad) {
    const dist = Math.abs(angleRad - d);
    if (dist <= bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

/** Outer "stays visible" clamp for `position.z` (world units). Pure.
 *  @deprecated Use `clampDepthForKind` for new code — it applies the correct
 *  per-kind limit. This overload is retained for callers that already use it. */
export function clampDepth(z: number, max = 1800): number {
  return Math.max(-max, Math.min(max, z));
}

/**
 * Z range for 3D-world overlays (three / text with threeD), in world units.
 * Widened to ±4 so Depth can push content nearly out of sight (far) or right up
 * to the camera (very zoomed-in) — the user-requested expressive range. The
 * billboard camera sits ~6 units back; at +4 the content is close (≈2 units
 * away, big) and at −4 it's distant (≈10 units, small) but still on-screen.
 */
export const DEPTH_LIMIT_WORLD = 4;

/**
 * Z range for quad overlay kinds (image / video / code), in pixel-space
 * position.z. Widened to ±500 to match the expanded world range's expressiveness.
 */
export const DEPTH_LIMIT_PX = 500;

/**
 * Per-kind safe Z range clamp. World units for three/text (3D-text); pixels
 * for quad kinds (image/video/code). Keeps content on-screen regardless of
 * what the drag or slider emits.
 */
export function clampDepthForKind(z: number, kind: string): number {
  const lim = kind === "three" || kind === "text" ? DEPTH_LIMIT_WORLD : DEPTH_LIMIT_PX;
  return Math.max(-lim, Math.min(lim, z));
}
