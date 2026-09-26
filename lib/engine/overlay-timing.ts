/** Pure element-local timing math shared by the renderer and tests.
 *  Dependency-free on purpose. */

/** Clamp a number to [0, 1]. */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export interface ElementTiming {
  /** Frame index within the element (0-indexed). */
  frame: number;
  /** Time in seconds within the element (can be <0 before its window). */
  time: number;
  /** Total frames in the element's own window (>= 1). */
  totalFrames: number;
  /** The element's duration in seconds. */
  duration: number;
  /** Normalized 0→1 progress across the window. */
  progress: number;
}

/**
 * Remaps a composition-global time to an element's own [startTime, startTime+duration)
 * window. Used to give code overlays scene-consistent, element-local timing.
 */
export function elementTiming(
  globalTime: number,
  fps: number,
  startTime: number,
  duration: number,
): ElementTiming {
  const time = globalTime - startTime;
  const frame = Math.round(time * fps);
  const totalFrames = Math.max(1, Math.round(duration * fps));
  const progress = duration > 0 ? clamp01(time / duration) : 0;
  return { frame, time, totalFrames, duration, progress };
}

/** A second rounded to the millisecond — how every reported frame time
 *  (render diagnostics, the last valid time) is written. `frameForTime`
 *  (`lib/render/frame-capture.ts`) snaps a time within 1 ms of a frame onto
 *  that frame, so a frame's time rounded here reads back as that frame. */
export function roundToMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * The composition frame an element-local frame is drawn on, and its time —
 * the inverse of `elementTiming`. The time is taken FROM the frame: with a
 * start that is not frame-aligned, `startTime + localFrame / fps` falls
 * between frames and renders a different one (Task 12b re-review 3, N3).
 * `elementTiming` rounds `G − startTime·fps` half up, so at a start exactly
 * half a frame in, the nearest G draws the NEXT local frame; the neighbour
 * that maps back is taken instead. (There, float noise also leaves the odd
 * local frame drawn on no composition frame; it keeps the nearest one.)
 */
export function compositionFrameAt(localFrame: number, startTime: number, fps: number): { frame: number; time: number } {
  const nearest = Math.round(startTime * fps + localFrame);
  const frame =
    [nearest, nearest - 1, nearest + 1].find((g) => elementTiming(g / fps, fps, startTime, 0).frame === localFrame) ?? nearest;
  return { frame, time: roundToMs(frame / fps) };
}
