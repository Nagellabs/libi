/**
 * Pure, environment-agnostic math used by the two-stage face detection
 * pipeline. Lives outside `face-detection.ts` so it can be exercised in
 * a plain Node Vitest run (no canvas, no MediaPipe, no browser).
 */

export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Inflate a bbox by `padding` (fraction of its size) around its center. */
export function padBbox(b: Bbox, padding: number): Bbox {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const w = b.w * (1 + padding);
  const h = b.h * (1 + padding);
  return {
    x: Math.round(cx - w / 2),
    y: Math.round(cy - h / 2),
    w: Math.round(w),
    h: Math.round(h),
  };
}

/** Clamp a bbox so it sits entirely within a `frameW × frameH` frame. */
export function clampBboxToFrame(b: Bbox, frameW: number, frameH: number): Bbox {
  const x = Math.max(0, Math.min(frameW, b.x));
  const y = Math.max(0, Math.min(frameH, b.y));
  const right = Math.max(x, Math.min(frameW, b.x + b.w));
  const bottom = Math.max(y, Math.min(frameH, b.y + b.h));
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * Convert a bbox expressed in crop-local coordinates back into the
 * coordinates of the original frame the crop was taken from.
 */
export function translateBboxFromCrop(
  bboxInCrop: Bbox,
  cropOrigin: { x: number; y: number },
): Bbox {
  return {
    x: bboxInCrop.x + cropOrigin.x,
    y: bboxInCrop.y + cropOrigin.y,
    w: bboxInCrop.w,
    h: bboxInCrop.h,
  };
}
