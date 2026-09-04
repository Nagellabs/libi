/**
 * Pure timeline-zoom model. Maps a zoom expressed as content px-per-second to
 * content width, a display %, wheel steps, and the cursor-anchored scrollLeft.
 * NO React, NO DOM. The timeline feeds contentWidth() into LaneView.trackWidth
 * so all existing lane-bar-geometry keeps working against the wider canvas.
 */
export const ZOOM_MIN_PX_PER_SEC = 4;

/** Widest a single frame may be drawn, in px. Max zoom is defined by the FRAME:
 *  past roughly this you are magnifying one frame rather than seeing more. */
export const MAX_PX_PER_FRAME = 40;

/** The zoom ceiling for a composition at `fps`. Derived from fps rather than
 *  fixed, because a fixed px/sec ceiling means different things at different
 *  frame rates — the old flat 4000 was 133px/frame at 30fps but 67px/frame at
 *  60fps, so "max zoom" showed twice the detail on one project as another. */
export function maxPxPerSec(fps: number): number {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return Math.max(ZOOM_MIN_PX_PER_SEC, MAX_PX_PER_FRAME * safeFps);
}

export function clampPxPerSec(px: number, maxPx: number): number {
  if (!Number.isFinite(px) || px <= 0) return ZOOM_MIN_PX_PER_SEC;
  return Math.max(ZOOM_MIN_PX_PER_SEC, Math.min(maxPx, px));
}

// fitPxPerSec keeps ONLY the lower bound (ZOOM_MIN) — never the max-zoom
// ceiling. Fit is the floor: the timeline must always fill its viewport, and a
// short piece in a wide panel can legitimately need a fit above the per-frame
// ceiling. Clamping fit down would render the timeline narrower than its
// panel and reintroduce the bug this model exists to fix.
export function fitPxPerSec(viewportWidth: number, totalSeconds: number): number {
  if (viewportWidth <= 0 || totalSeconds <= 0) return ZOOM_MIN_PX_PER_SEC;
  return Math.max(ZOOM_MIN_PX_PER_SEC, viewportWidth / totalSeconds);
}

export function contentWidth(pxPerSec: number, totalSeconds: number): number {
  return Math.max(0, pxPerSec * Math.max(0, totalSeconds));
}

// A percentage-of-Fit reads as an unreadably large number on a long piece (Fit
// can be well under 1px/frame, so max zoom is tens of thousands of percent) —
// a multiplier of Fit stays legible at any composition length. Sub-10x keeps
// one decimal place because whole numbers alone would flatten the low end of
// the (log-scaled) slider into a run of identical-looking labels.
export function zoomMultiplierLabel(pxPerSec: number, fitPx: number): string {
  const rawRatio = !Number.isFinite(fitPx) || fitPx <= 0 ? 1 : pxPerSec / fitPx;
  const ratio = Math.max(1, Number.isFinite(rawRatio) ? rawRatio : 1);
  if (ratio < 10) {
    return `×${ratio.toFixed(1).replace(/\.0$/, "")}`;
  }
  return `×${Math.round(ratio)}`;
}

/**
 * Slider position ⇄ zoom, logarithmic. Position 0 is Fit (the floor — the
 * timeline can never be narrower than its viewport) and 1 is `maxPx`, so
 * equal slider travel is an equal RATIO of zoom rather than an equal number of
 * pixels-per-second. A linear map would spend most of its travel in the last
 * doubling and feel dead at the low end.
 *
 * A composition short enough that Fit already exceeds the max zoom has no range
 * to offer: both directions collapse onto the endpoint instead of dividing by
 * a zero-width (log) span.
 */
function zoomSpan(fitPx: number, maxPx: number): number {
  if (!Number.isFinite(fitPx) || fitPx <= 0) return 1;
  return maxPx / fitPx;
}

export function zoomFromSliderPos(pos: number, fitPx: number, maxPx: number): number {
  const span = zoomSpan(fitPx, maxPx);
  if (span <= 1) return Math.min(fitPx, maxPx);
  const p = Math.max(0, Math.min(1, pos));
  return fitPx * Math.pow(span, p);
}

export function sliderPosFromZoom(pxPerSec: number, fitPx: number, maxPx: number): number {
  const span = zoomSpan(fitPx, maxPx);
  if (span <= 1) return 0;
  const ratio = pxPerSec / fitPx;
  if (!Number.isFinite(ratio) || ratio <= 1) return 0;
  return Math.max(0, Math.min(1, Math.log(ratio) / Math.log(span)));
}

export function applyWheelZoom(args: { pxPerSec: number; factor: number; maxPx: number }): number {
  return clampPxPerSec(args.pxPerSec * args.factor, args.maxPx);
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
