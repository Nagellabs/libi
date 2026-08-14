/**
 * Pure keyframe-diamond geometry for the timeline overlay bars. Maps each
 * normalized keyframe time `t` (0→1 within the overlay window — exactly what
 * `overlayKeyframeTimes(overlay)` returns) to its x offset in px INSIDE the bar.
 *
 * A keyframe at `t` sits `t * barWidthPx` from the bar's left edge (the bar's
 * pixel span already IS the overlay window, so the `t*duration/duration` in the
 * plan reduces to `t`). Values are clamped to `[0, barWidthPx]` so a floating-
 * point `t` slightly outside `[0,1]` can never paint past the bar. NO React, NO
 * DOM — unit-tested in isolation.
 */

/** Clamp a normalized time to [0,1] (defends against fp drift on stored `t`). */
function clamp01(t: number): number {
  if (!Number.isFinite(t)) return 0;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * The x offset (px, from the bar's left edge) for one normalized keyframe time.
 * `barWidthPx` ≤ 0 (degenerate bar) → 0.
 *
 * `insetPx` (default 0) keeps an EDGE keyframe's diamond fully inside the
 * `overflow-hidden` bar: the center is clamped to `[insetPx, barWidthPx-insetPx]`
 * so a `t=0` / `t=1` marker isn't half-clipped at the boundary. Interior
 * keyframes (already within that band) are untouched; a bar too narrow for the
 * inset clamps it to the bar's midpoint.
 */
export function keyframeMarkerX(t: number, barWidthPx: number, insetPx = 0): number {
  if (!(barWidthPx > 0)) return 0;
  const raw = clamp01(t) * barWidthPx;
  if (!(insetPx > 0)) return raw;
  const inset = Math.min(insetPx, barWidthPx / 2);
  return Math.min(Math.max(raw, inset), barWidthPx - inset);
}

/**
 * True when normalized keyframe time `t` is within ~1 frame of the playhead —
 * used to HIGHLIGHT the diamond under the playhead and to gate the "Delete
 * keyframe" menu item. Both `t` and `playheadT` are normalized 0→1 within the
 * SAME overlay window; the tolerance is one frame expressed in that normalized
 * space (`1 / (durationSec * fps)` = `1 / totalFramesInWindow`). A degenerate
 * window (≤0 frames) falls back to exact equality.
 */
export function isKeyframeAtPlayhead(
  t: number,
  playheadT: number,
  durationSec: number,
  fps: number,
): boolean {
  const framesInWindow = durationSec * fps;
  if (!(framesInWindow > 0)) return t === playheadT;
  const tol = 1 / framesInWindow;
  return Math.abs(t - playheadT) <= tol + 1e-9;
}
