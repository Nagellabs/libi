/**
 * Edge-overflow detector for the caption/overlay render-verify loop.
 *
 * Scans the 4 border bands of a decoded RGBA frame and reports which edges have
 * bright (non-background) content touching them — the signal that an overlay
 * (e.g. an over-scaled caption) is clipping out of frame. Pure + dependency-free:
 * the caller decodes the PNG → RGBA and passes the raw buffer.
 */
export type FrameEdge = "top" | "bottom" | "left" | "right";

export interface EdgeOverflowResult {
  touchesEdge: boolean;
  edges: FrameEdge[];
}

export interface EdgeOverflowOptions {
  /** A pixel counts as "content" when its luma exceeds this (0..255). */
  lumaThreshold?: number;
  /** Band thickness in pixels scanned inward from each border. */
  marginPx?: number;
  /** Minimum number of content pixels in a band to flag that edge. */
  minCount?: number;
}

const REC601 = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

export function detectEdgeOverflow(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  opts: EdgeOverflowOptions = {},
): EdgeOverflowResult {
  const lumaThreshold = opts.lumaThreshold ?? 40;
  const marginPx = Math.max(1, opts.marginPx ?? 2);
  const minCount = opts.minCount ?? 8;

  const bright = (x: number, y: number): boolean => {
    const i = (y * width + x) * 4;
    return REC601(rgba[i], rgba[i + 1], rgba[i + 2]) > lumaThreshold;
  };

  const edges: FrameEdge[] = [];
  const m = Math.min(marginPx, Math.floor(Math.min(width, height) / 2));

  // top / bottom bands
  let top = 0, bottom = 0;
  for (let y = 0; y < m; y++) {
    for (let x = 0; x < width; x++) {
      if (bright(x, y)) top++;
      if (bright(x, height - 1 - y)) bottom++;
    }
  }
  // left / right bands
  let left = 0, right = 0;
  for (let x = 0; x < m; x++) {
    for (let y = 0; y < height; y++) {
      if (bright(x, y)) left++;
      if (bright(width - 1 - x, y)) right++;
    }
  }

  if (top >= minCount) edges.push("top");
  if (bottom >= minCount) edges.push("bottom");
  if (left >= minCount) edges.push("left");
  if (right >= minCount) edges.push("right");

  return { touchesEdge: edges.length > 0, edges };
}
