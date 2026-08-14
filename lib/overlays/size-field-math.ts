/**
 * Pure size math for the `SizeField` inspector control.
 *
 * The single-row "Size" mode edits WIDTH and keeps HEIGHT proportional. These
 * two helpers are the entire math surface: capture the current aspect ratio
 * (`aspectOf`), then derive the proportional height for a new width
 * (`aspectLockedHeight`). Both guard degenerate inputs so a 0/NaN dimension can
 * never produce a NaN/Infinity rect.
 */

/**
 * Aspect ratio = width / height. Returns `1` (square) when height is
 * non-positive so callers never divide by zero downstream.
 */
export function aspectOf(width: number, height: number): number {
  return height > 0 ? width / height : 1;
}

/**
 * Height that keeps the box at the given `aspect` (= width/height) for a new
 * `width`. Rounded to whole pixels. Guards a non-finite / non-positive aspect
 * by falling back to a square (height = width).
 */
export function aspectLockedHeight(width: number, aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return Math.round(width);
  return Math.round(width / aspect);
}
