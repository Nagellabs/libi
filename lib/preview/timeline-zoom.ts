/**
 * Pure timeline-zoom model. Maps a zoom expressed as content px-per-second to
 * content width, a display %, wheel steps, and the cursor-anchored scrollLeft.
 * NO React, NO DOM. The timeline feeds contentWidth() into LaneView.trackWidth
 * so all existing lane-bar-geometry keeps working against the wider canvas.
 */
export const ZOOM_MIN_PX_PER_SEC = 4;
export const ZOOM_MAX_PX_PER_SEC = 4000;

export function clampPxPerSec(px: number): number {
  if (!Number.isFinite(px) || px <= 0) return ZOOM_MIN_PX_PER_SEC;
  return Math.max(ZOOM_MIN_PX_PER_SEC, Math.min(ZOOM_MAX_PX_PER_SEC, px));
}

export function fitPxPerSec(viewportWidth: number, totalSeconds: number): number {
  if (viewportWidth <= 0 || totalSeconds <= 0) return ZOOM_MIN_PX_PER_SEC;
  return clampPxPerSec(viewportWidth / totalSeconds);
}

export function contentWidth(pxPerSec: number, totalSeconds: number): number {
  return Math.max(0, pxPerSec * Math.max(0, totalSeconds));
}

export function zoomFactorPercent(pxPerSec: number, fitPx: number): number {
  if (fitPx <= 0) return 100;
  return Math.round((pxPerSec / fitPx) * 100);
}

export function applyWheelZoom(args: { pxPerSec: number; factor: number }): number {
  return clampPxPerSec(args.pxPerSec * args.factor);
}

export function anchoredScrollLeft(args: {
  pointerX: number;
  prevScrollLeft: number;
  oldPxPerSec: number;
  newPxPerSec: number;
}): number {
  const { pointerX, prevScrollLeft, oldPxPerSec, newPxPerSec } = args;
  if (oldPxPerSec <= 0) return Math.max(0, prevScrollLeft);
  const timeUnderPointer = (prevScrollLeft + pointerX) / oldPxPerSec;
  const next = timeUnderPointer * newPxPerSec - pointerX;
  return Math.max(0, next);
}
