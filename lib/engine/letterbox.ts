export interface FittedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Compute a destination rect for `drawImage` that preserves the source's
 * aspect ratio inside a target (composition) rect. Letterboxes (black bars
 * top/bottom) or pillarboxes (black bars left/right) as needed.
 *
 * Pure function — no DOM, no canvas, no side effects. Designed to be trivial
 * to unit test and easy to extend later with fit-modes (cover / fill /
 * contain-at-scale / specific anchors).
 */
export function fitRect(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): FittedRect {
  if (srcW <= 0 || srcH <= 0) {
    return { x: 0, y: 0, w: dstW, h: dstH };
  }
  const srcAR = srcW / srcH;
  const dstAR = dstW / dstH;
  if (srcAR > dstAR) {
    // Source is wider → letterbox (bars top/bottom)
    const h = dstW / srcAR;
    return { x: 0, y: Math.floor((dstH - h) / 2), w: dstW, h: Math.floor(h) };
  }
  // Source is taller or equal → pillarbox (bars left/right)
  const w = dstH * srcAR;
  return { x: Math.floor((dstW - w) / 2), y: 0, w: Math.floor(w), h: dstH };
}

/**
 * Compute a destination rect for `drawImage` that FILLS a target rect while
 * preserving the source aspect ratio — the CSS `object-fit: cover` behavior.
 * Overflow extends past the rect edges (caller should clip to the rect). The
 * returned x/y are offsets relative to the rect origin (may be negative).
 *
 * Pure function — mirror of `fitRect` (which is `contain`).
 */
export function coverRect(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): FittedRect {
  if (srcW <= 0 || srcH <= 0) {
    return { x: 0, y: 0, w: dstW, h: dstH };
  }
  const srcAR = srcW / srcH;
  const dstAR = dstW / dstH;
  if (srcAR > dstAR) {
    // Source is wider → match height, overflow left/right.
    const w = dstH * srcAR;
    return { x: Math.floor((dstW - w) / 2), y: 0, w: Math.floor(w), h: dstH };
  }
  // Source is taller or equal → match width, overflow top/bottom.
  const h = dstW / srcAR;
  return { x: 0, y: Math.floor((dstH - h) / 2), w: dstW, h: Math.floor(h) };
}
