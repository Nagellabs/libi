export interface FilmstripGeometryInput {
  /** Rendered width of the timeline bar in px (follows Plan B zoom). */
  barWidthPx: number;
  /** Number of frames tiled into the sprite. */
  frames: number;
  /** Per-frame height of the sprite in px. */
  frameHeightPx: number;
}

export interface FilmstripBackgroundStyle {
  backgroundSize: string;
  backgroundRepeat: string;
}

/**
 * Compute the CSS background sizing for painting a horizontal filmstrip sprite
 * inside a timeline bar at any width (zoom-aware).
 *
 * The sprite is a single wide JPG (`frames` frames laid side-by-side at
 * `frameHeightPx`). We paint it at `100% 100%` so it stretches to exactly fill
 * the bar — bar height drives the vertical size, bar width drives how much of
 * the horizontal strip is visible. As the bar gets wider (zoom in), more of the
 * strip's detail is revealed per pixel; as it shrinks, frames compress. This is
 * the Premiere/Resolve/CapCut feel without any per-frame slicing math, and it's
 * robust to the degenerate zero inputs that can happen on first mount before
 * layout settles.
 *
 * `frames` / `frameHeightPx` are accepted for future per-frame-snapping tuning;
 * the current strategy doesn't need them, but keeping them in the signature
 * means call sites already thread the sprite metadata.
 */
export function filmstripBackgroundStyle(
  _input: FilmstripGeometryInput,
): FilmstripBackgroundStyle {
  return {
    backgroundSize: "100% 100%",
    backgroundRepeat: "no-repeat",
  };
}
