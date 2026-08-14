// Pure drag math for the tracked-overlay REPOSITION gesture (default-mode
// drag; the "Adjust tracking" mode drag re-anchors the TRACK instead — see
// preview-player.tsx). Kept dependency-light and unit-tested; the exact
// inverse of resolveTrackedRect's offset application.
import { applyFitAndScale } from "@/lib/engine/overlay-renderer";
import type { TrackFit } from "@/lib/tracking/types";

export interface OffsetFromDropOpts {
  /** Sampled track bbox at the drag time (sampleTrack output). */
  sample: { x: number; y: number; w: number; h: number };
  rect: { x: number; y: number; width: number; height: number };
  fit: TrackFit;
  scale: number;
  frame: { width: number; height: number };
  /** Desired art CENTER, in composition pixels. */
  drop: { x: number; y: number };
}

/** Persistence bound for each offset axis — MUST match TrackedOffsetSchema in
 *  mcp/tools/schemas.ts (`z.number().min(-10).max(10)`). An offset outside
 *  this range would 400 on the overlay PATCH and silently revert on reload. */
const OFFSET_AXIS_BOUND = 10;

const clampAxis = (v: number) =>
  Math.min(OFFSET_AXIS_BOUND, Math.max(-OFFSET_AXIS_BOUND, v));

/** The normalized follow offset implied by centering the tracked art at
 *  `drop`: fractions of the UN-offset resolved art box, clamped to the
 *  TrackedOffsetSchema bound (±10 per axis) so a far drag of a small box
 *  always persists validly. Degenerate art (zero-size) ⇒ zero offset
 *  (never NaN). */
export function offsetFromDrop(o: OffsetFromDropOpts): { x: number; y: number } {
  const base = applyFitAndScale(o.sample, o.rect, o.fit, o.scale, o.frame);
  if (base.w <= 0 || base.h <= 0) return { x: 0, y: 0 };
  const cx = base.x + base.w / 2;
  const cy = base.y + base.h / 2;
  return {
    x: clampAxis((o.drop.x - cx) / base.w),
    y: clampAxis((o.drop.y - cy) / base.h),
  };
}
