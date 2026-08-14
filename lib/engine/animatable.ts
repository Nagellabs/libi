import type { ElementTiming } from "./overlay-timing";
import type { OverlayRect, Vec3, Transform3D } from "./types";
import { resolveEasing } from "./easing-registry";

/** A keyframed value — reserved shape for the future keyframe spec. */
export interface Keyframed<T> {
  keyframes: Array<{ t: number; value: T; easing?: string }>;
}

/** A property that is either a constant or keyframed. */
export type Animatable<T> = T | Keyframed<T>;

export function isKeyframed<T>(v: Animatable<T>): v is Keyframed<T> {
  return typeof v === "object" && v !== null && Array.isArray((v as Keyframed<T>).keyframes);
}

// ---------------------------------------------------------------------------
// Shape detection for generic lerp
// ---------------------------------------------------------------------------

function isOverlayRect(v: unknown): v is OverlayRect {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as OverlayRect).x === "number" &&
    typeof (v as OverlayRect).y === "number" &&
    typeof (v as OverlayRect).width === "number" &&
    typeof (v as OverlayRect).height === "number"
  );
}

function isVec3(v: unknown): v is Vec3 {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Vec3).x === "number" &&
    typeof (v as Vec3).y === "number" &&
    typeof (v as Vec3).z === "number"
  );
}

function isTransform3D(v: unknown): v is Transform3D {
  return (
    typeof v === "object" &&
    v !== null &&
    isVec3((v as Transform3D).position) &&
    isVec3((v as Transform3D).rotation)
  );
}

const lerpNum = (a: number, b: number, e: number) => a + (b - a) * e;

const lerpVec3 = (a: Vec3, b: Vec3, e: number): Vec3 => ({
  x: lerpNum(a.x, b.x, e),
  y: lerpNum(a.y, b.y, e),
  z: lerpNum(a.z, b.z, e),
});

/**
 * Interpolate between two same-shaped values. Runtime-dispatches on the value
 * shape since `T` is erased. Non-lerpable values (boolean/string) step: `e < 1`
 * yields `a`, otherwise `b`.
 */
function lerpGeneric<T>(a: T, b: T, e: number): T {
  if (typeof a === "number" && typeof b === "number") {
    return lerpNum(a, b, e) as T;
  }
  // Transform3D before Vec3 (a Transform3D is not a Vec3, but check the more
  // specific shape first for clarity).
  if (isTransform3D(a) && isTransform3D(b)) {
    return {
      position: lerpVec3(a.position, b.position, e),
      rotation: lerpVec3(a.rotation, b.rotation, e),
    } as T;
  }
  if (isOverlayRect(a) && isOverlayRect(b)) {
    return {
      x: lerpNum(a.x, b.x, e),
      y: lerpNum(a.y, b.y, e),
      width: lerpNum(a.width, b.width, e),
      height: lerpNum(a.height, b.height, e),
    } as T;
  }
  if (isVec3(a) && isVec3(b)) {
    return lerpVec3(a, b, e) as T;
  }
  // Unknown / non-lerpable → step.
  return e < 1 ? a : b;
}

/**
 * Resolve an animatable property at the given element-local time. Constants
 * return unchanged (behavior-neutral). Keyframed values interpolate across
 * `timing.progress` (normalized 0→1 within the overlay window), holding at the
 * ends. The easing on the LEFT keyframe governs the segment leaving it.
 */
export function valueAt<T>(v: Animatable<T>, timing: ElementTiming): T {
  if (!isKeyframed(v)) return v;

  const ks = v.keyframes;
  if (ks.length === 0) return undefined as T;
  if (ks.length === 1) return ks[0].value;

  // Sort defensively without mutating input.
  const sorted = [...ks].sort((x, y) => x.t - y.t);
  const p = timing.progress;

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (p <= first.t) return first.value;
  if (p >= last.t) return last.value;

  // Find the segment [ks[i].t, ks[i+1].t) containing p.
  let i = 0;
  for (let j = 0; j < sorted.length - 1; j++) {
    if (sorted[j].t <= p && p < sorted[j + 1].t) {
      i = j;
      break;
    }
  }

  const left = sorted[i];
  const right = sorted[i + 1];
  const span = right.t - left.t;
  // Shared-t keyframes → step to the right value.
  if (span <= 0) return right.value;

  const local = (p - left.t) / span;
  const eased = resolveEasing(left.easing)(local);
  return lerpGeneric(left.value, right.value, eased);
}
