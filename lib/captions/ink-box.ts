/**
 * Visible-ink bounding box for a wrapped text block, in composition pixels.
 *
 * The renderer (`drawTextOverlay`) places glyphs inside the LINE box
 * (`overlay.rect`, height = lines × lineHeightPx) with `textBaseline:"top"`.
 * For ascender-only text (e.g. "hello world", no descenders) the visible ink
 * hugs the top of the line box and the descender region + line-height leading
 * is empty space at the bottom — so a selection box drawn at `overlay.rect`
 * looks top-aligned. `assembleInkBox` instead wraps the actual visible ink and
 * adds uniform padding, so the glyphs sit centered inside the box.
 *
 * This module is the PURE assembly half: the caller measures each wrapped line
 * with a real 2D context (`textBaseline:"top"`) and passes the per-line ink
 * extents. Keeping the geometry pure makes it unit-testable without a canvas.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Per-line ink extents, all measured with `textBaseline:"top"`. */
export interface LineInk {
  /** Advance width of the line (composition px). */
  width: number;
  /** Pixels DOWN from the line's draw point to the top of the visible ink
   *  (= `-metrics.actualBoundingBoxAscent`; small positive for most text). */
  inkAscentFromTop: number;
  /** Pixels DOWN from the line's draw point to the bottom of the visible ink
   *  (= `metrics.actualBoundingBoxDescent`). */
  inkDescentFromTop: number;
}

export interface AssembleInkBoxParams {
  /** The overlay's LINE box (`overlay.rect`) — the geometry the renderer draws within. */
  rect: Rect;
  /** Wrapped lines, in draw order. Empty ⇒ the line box is returned verbatim. */
  lines: LineInk[];
  /** `fontSizePx × lineHeight` — the renderer's vertical line advance. */
  lineHeightPx: number;
  /** Horizontal alignment, matching `overlay.align`. */
  align: "left" | "center" | "right";
  /** Uniform padding added on every side (composition px). */
  padPx: number;
}

/**
 * Assemble the padded visible-ink box from per-line ink extents, mirroring the
 * renderer's exact vertical layout (`yOffset` centering + per-line advance).
 */
export function assembleInkBox(params: AssembleInkBoxParams): Rect {
  const { rect, lines, lineHeightPx, align, padPx } = params;
  if (lines.length === 0) return rect;

  // Mirror the renderer's vertical centering of the text block within `rect`.
  const totalTextHeight = lines.length * lineHeightPx;
  const yOffset = Math.max(0, (rect.height - totalTextHeight) / 2);

  let inkTop = Infinity;
  let inkBottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTop = rect.y + yOffset + i * lineHeightPx;
    inkTop = Math.min(inkTop, lineTop + line.inkAscentFromTop);
    inkBottom = Math.max(inkBottom, lineTop + line.inkDescentFromTop);

    // Horizontal extent follows the renderer's per-align anchor.
    let lineLeft: number;
    if (align === "center") {
      const cx = rect.x + rect.width / 2;
      lineLeft = cx - line.width / 2;
    } else if (align === "right") {
      lineLeft = rect.x + rect.width - line.width;
    } else {
      lineLeft = rect.x;
    }
    left = Math.min(left, lineLeft);
    right = Math.max(right, lineLeft + line.width);
  }

  return {
    x: left - padPx,
    y: inkTop - padPx,
    width: right - left + padPx * 2,
    height: inkBottom - inkTop + padPx * 2,
  };
}
