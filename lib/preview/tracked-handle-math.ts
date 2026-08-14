// Pure gesture math for the TRACKED overlay's direct-manipulation handles.
// Tracked art placement comes from the track (+ follow offset), so its handles
// never write `rect` — corners drive the uniform `scale` field, the rotate
// knob drives `transform3d.rotation.z` (the single rotation authority).
// Consumed by components/preview/tracked-transform-controls.tsx.
import { applyRotateDrag } from "@/lib/preview/overlay-drag-math";
import type { Transform3D } from "@/lib/engine/types";

/** Persistence bounds — MUST match updateOverlaySchema.scale (positive ≤ 5);
 *  the 0.05 floor keeps the art grabbable (a ~0 scale would be unrecoverable
 *  by direct manipulation). Same clamp-at-the-gesture lesson as the follow
 *  offset (commit a76a44cd): never let a drag produce a value the PATCH
 *  schema rejects. */
export const TRACKED_SCALE_MIN = 0.05;
export const TRACKED_SCALE_MAX = 5;

/** Inspector "Size" display value (percent) from the persisted `scale`
 *  multiplier — the tracked inspector's Size field shows the SAME field the
 *  corner handles write, so gizmo and inspector stay in sync by construction. */
export function trackedSizePctFromScale(scale: number): number {
  return Math.round(scale * 100);
}

/** The Size slider's floor for a given persisted scale: the standard 5%
 *  grabbability floor, LOWERED to the current value when a legacy/agent-set
 *  scale sits below it — so the first slider touch never snaps a sub-floor
 *  value up to 5%. Naturally ratchets back to the standard floor once the
 *  user raises the scale. Degenerate (≤0 / non-finite) scales fall back to
 *  the standard floor. */
export function trackedSizeFloorScale(currentScale: number): number {
  if (!Number.isFinite(currentScale) || currentScale <= 0) {
    return TRACKED_SCALE_MIN;
  }
  return Math.min(TRACKED_SCALE_MIN, currentScale);
}

/** Persisted `scale` multiplier from the inspector "Size" percent, clamped to
 *  the same bounds as the corner-handle drag (updateOverlaySchema-safe).
 *  Pass `currentScale` so a sub-floor legacy/agent-set value keeps its own
 *  floor instead of snapping to 5% (see trackedSizeFloorScale). */
export function trackedScaleFromSizePct(
  pct: number,
  currentScale?: number,
): number {
  const floor =
    currentScale === undefined
      ? TRACKED_SCALE_MIN
      : trackedSizeFloorScale(currentScale);
  return Math.min(TRACKED_SCALE_MAX, Math.max(floor, pct / 100));
}

export interface TrackedScaleDragOpts {
  /** Resolved art box at POINTER-DOWN (composition px). Its center is
   *  scale-invariant (applyFitAndScale scales about the bbox center), so the
   *  captured box stays a valid anchor while the live box grows under the
   *  cursor. */
  art: { x: number; y: number; w: number; h: number };
  /** overlay.scale at pointer-down. */
  startScale: number;
  /** Pointer-down / current pointer, composition px. */
  down: { x: number; y: number };
  cur: { x: number; y: number };
}

/**
 * Uniform corner-resize: scale by the ratio of center-distances. Rotation-
 * invariant by construction (distances don't care about spin), so the same
 * math serves a rotated box with no inverse-rotation step.
 */
export function trackedScaleFromDrag(o: TrackedScaleDragOpts): number {
  const cx = o.art.x + o.art.w / 2;
  const cy = o.art.y + o.art.h / 2;
  const r0 = Math.hypot(o.down.x - cx, o.down.y - cy);
  if (r0 < 1e-6) return o.startScale; // degenerate anchor — no ratio to take
  const r1 = Math.hypot(o.cur.x - cx, o.cur.y - cy);
  const next = o.startScale * (r1 / r0);
  return Math.min(TRACKED_SCALE_MAX, Math.max(TRACKED_SCALE_MIN, next));
}

/**
 * Rotate-knob drag: the transform3d whose in-plane roll points the box's top
 * edge at `pt`. Reuses applyRotateDrag's angle frame (up = 0°, clockwise,
 * degrees) on the RESOLVED art box and preserves every other transform3d
 * component (out-of-plane rotation + position).
 */
export function spinTransformAt(
  base: Transform3D,
  art: { x: number; y: number; w: number; h: number },
  pt: { x: number; y: number },
): Transform3D {
  const deg = applyRotateDrag(
    { x: art.x, y: art.y, width: art.w, height: art.h },
    { compX: pt.x, compY: pt.y },
  );
  return { ...base, rotation: { ...base.rotation, z: (deg * Math.PI) / 180 } };
}
