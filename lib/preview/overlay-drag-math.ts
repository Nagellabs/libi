/**
 * Pure drag math for the canvas transform controls. Converts a pointer delta
 * (DISPLAY px) into a composition-space rect move / resize-from-handle, and a
 * pointer position into a rotation-about-center. NO React, NO DOM. The display
 * scale (`scaleX = canvasDisplayWidth / compositionWidth`) mirrors
 * `overlay-editor.tsx`; resize honors the overlay's current rotation by mapping
 * the display delta into the overlay's local (unrotated) frame — matching the
 * renderer's center-anchored transform.
 */
import type { OverlayRect } from "@/lib/engine/types";

/** The 8 resize handles: corners + edge midpoints. */
export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export interface DisplayDelta {
  dxDisplay: number;
  dyDisplay: number;
}

export interface DisplayScale {
  /** canvasDisplayWidth / compositionWidth */
  scaleX: number;
  /** canvasDisplayHeight / compositionHeight */
  scaleY: number;
}

/** Smallest rect side (composition px) a resize may produce. */
export const MIN_RECT_SIDE = 8;

/** Display delta → composition delta (divide by scale). */
function toCompDelta(d: DisplayDelta, scale: DisplayScale): { dx: number; dy: number } {
  return {
    dx: scale.scaleX > 0 ? d.dxDisplay / scale.scaleX : 0,
    dy: scale.scaleY > 0 ? d.dyDisplay / scale.scaleY : 0,
  };
}

/** Rotate a (dx,dy) vector by `deg` degrees (clockwise, screen-y-down). */
function rotateVec(dx: number, dy: number, deg: number): { dx: number; dy: number } {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { dx: dx * cos - dy * sin, dy: dx * sin + dy * cos };
}

/**
 * Move: translate the rect by the scaled delta. Rotation is irrelevant —
 * translation commutes with the center-anchored transform.
 */
export function applyMoveDrag(
  rect: OverlayRect,
  delta: DisplayDelta,
  scale: DisplayScale,
  _rotationDeg: number,
): OverlayRect {
  const { dx, dy } = toCompDelta(delta, scale);
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

/** Which edges a handle drives: -1 grows toward the min edge, +1 the max edge. */
const HANDLE_AXES: Record<HandleId, { ex: -1 | 0 | 1; ey: -1 | 0 | 1 }> = {
  nw: { ex: -1, ey: -1 },
  n: { ex: 0, ey: -1 },
  ne: { ex: 1, ey: -1 },
  e: { ex: 1, ey: 0 },
  se: { ex: 1, ey: 1 },
  s: { ex: 0, ey: 1 },
  sw: { ex: -1, ey: 1 },
  w: { ex: -1, ey: 0 },
};

/**
 * Resize from a handle. The display delta is converted to composition px then
 * rotated by `-rotationDeg` into the overlay's local frame (so a handle on the
 * rotated box still resizes the dimension it visually points at). The grabbed
 * edge(s) move; the opposite edge stays fixed (so x/width or y/height shift in
 * lockstep). Clamped to MIN_RECT_SIDE.
 */
export function applyResizeDrag(
  rect: OverlayRect,
  handle: HandleId,
  delta: DisplayDelta,
  scale: DisplayScale,
  rotationDeg: number,
): OverlayRect {
  const comp = toCompDelta(delta, scale);
  // Map the comp delta into the overlay's local (unrotated) axes.
  const local = rotateVec(comp.dx, comp.dy, -rotationDeg);
  const { ex, ey } = HANDLE_AXES[handle];

  let { x, y, width, height } = rect;

  if (ex === 1) {
    width = Math.max(MIN_RECT_SIDE, width + local.dx);
  } else if (ex === -1) {
    const newWidth = Math.max(MIN_RECT_SIDE, width - local.dx);
    x += width - newWidth;
    width = newWidth;
  }
  if (ey === 1) {
    height = Math.max(MIN_RECT_SIDE, height + local.dy);
  } else if (ey === -1) {
    const newHeight = Math.max(MIN_RECT_SIDE, height - local.dy);
    y += height - newHeight;
    height = newHeight;
  }
  return { x, y, width, height };
}

/**
 * Rotate: degrees (clockwise, 0 = pointer straight above the rect center) from
 * the rect center to the pointer (in COMPOSITION px). Normalized to [0,360).
 */
export function applyRotateDrag(
  rect: OverlayRect,
  pointer: { compX: number; compY: number },
): number {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = pointer.compX - cx;
  const dy = pointer.compY - cy;
  // atan2 with up = 0: angle from the +up axis, clockwise positive.
  let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  deg = ((deg % 360) + 360) % 360;
  return deg;
}
