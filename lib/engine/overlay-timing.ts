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
