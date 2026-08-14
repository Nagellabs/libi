/**
 * Pure timeline-bar geometry. Maps an overlay's [startTime, duration] (seconds)
 * to bar pixel rects within a track of a given width, and back. NO React, NO
 * DOM — unit-tested in isolation. The timeline + OverlayBar use this for every
 * left/width computation and the px→seconds inverse during a drag.
 */

/** The timeline track's measured geometry. */
export interface LaneView {
  /** Track width in CSS px. */
  trackWidth: number;
  /** Total composition frames the track spans. */
  totalFrames: number;
  /** Composition fps. */
  fps: number;
}

/** Seconds the track spans (totalFrames / fps), 0 when the view is degenerate. */
function totalSecondsOf(view: LaneView): number {
  if (view.totalFrames <= 0 || view.fps <= 0) return 0;
  return view.totalFrames / view.fps;
}

/** Map an overlay's timing to a bar pixel rect. Zero-width on a degenerate view. */
export function laneBarRect(
  timing: { startTime: number; duration: number },
  view: LaneView,
): { leftPx: number; widthPx: number } {
  const total = totalSecondsOf(view);
  if (total <= 0 || view.trackWidth <= 0) return { leftPx: 0, widthPx: 0 };
  const pxPerSec = view.trackWidth / total;
  return {
    leftPx: timing.startTime * pxPerSec,
    widthPx: timing.duration * pxPerSec,
  };
}

/** Inverse: a left-edge pixel offset → its composition seconds, clamped ≥ 0. */
export function pxToSeconds(px: number, view: LaneView): number {
  const total = totalSecondsOf(view);
  if (total <= 0 || view.trackWidth <= 0) return 0;
  const secPerPx = total / view.trackWidth;
  return Math.max(0, px * secPerPx);
}

/** Smallest a bar may be trimmed to (seconds) so it never collapses to 0. */
export const MIN_BAR_DURATION_SEC = 1 / 30;

/**
 * Keep a bar's [startTime, duration] fully inside [0, totalSeconds] with a
 * minimum positive duration. Used after every move/trim drag before commit.
 */
export function clampBarTiming(
  timing: { startTime: number; duration: number },
  totalSeconds: number,
): { startTime: number; duration: number } {
  const dur = Math.min(
    Math.max(MIN_BAR_DURATION_SEC, timing.duration),
    Math.max(MIN_BAR_DURATION_SEC, totalSeconds),
  );
  let start = Math.max(0, timing.startTime);
  if (start + dur > totalSeconds) start = Math.max(0, totalSeconds - dur);
  return { startTime: start, duration: dur };
}
