/**
 * Convert a SAM2 binary mask to a bounding box.
 *
 * SAM2 typically returns flat binary masks (0 = background, 1 = foreground).
 * This module handles that format and converts it to a bounding box.
 *
 * If the actual fal.ai SAM2 response format differs (e.g. pre-computed bboxes,
 * COCO RLE) the sam2-fal-backend.ts caller should pre-process the response
 * into a Mask before calling maskToBbox.
 */

export interface Mask {
  /** Flat array of 0/1 values, row-major (width × height elements). */
  data: number[] | Uint8Array;
  width: number;
  height: number;
}

export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

/**
 * Convert a binary mask to a bounding box.
 *
 * Returns the tight bounding box of all foreground pixels in the mask. For
 * multi-blob masks the bbox spans all blobs — this is fine for tracking a
 * single subject across noise. Returns null for empty masks.
 */
export function maskToBbox(mask: Mask): Bbox | null {
  const { data, width, height } = mask;

  if (
    typeof width !== "number" ||
    !isFinite(width) ||
    typeof height !== "number" ||
    !isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let pixelCount = 0;

  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    // Reject NaN / Infinity / non-numeric in any position
    if (typeof v !== "number" || !isFinite(v) || v === 0) continue;

    const px = i % width;
    const py = Math.floor(i / width);

    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
    pixelCount++;
  }

  if (pixelCount === 0) return null;

  // Clamp to frame bounds
  const x = Math.max(0, Math.min(minX, width - 1));
  const y = Math.max(0, Math.min(minY, height - 1));
  const x2 = Math.max(0, Math.min(maxX, width - 1));
  const y2 = Math.max(0, Math.min(maxY, height - 1));

  const w = x2 - x + 1;
  const h = y2 - y + 1;

  if (w <= 0 || h <= 0) return null;

  // Confidence is the foreground pixel ratio — higher density = higher confidence.
  const confidence = Math.min(1, pixelCount / (w * h));

  return { x, y, w, h, confidence };
}

/**
 * Decode a COCO RLE-encoded mask into a flat binary array.
 *
 * COCO RLE: `counts` is an alternating sequence of background-run / foreground-run
 * lengths starting from pixel 0, stored in column-major order.
 *
 * TODO: verify that fal.ai's SAM2 response actually uses COCO RLE and that the
 * [height, width] size ordering in `size` matches this decoder. Field-validate
 * against a real FAL_KEY response before enabling this path in production.
 */
export function decodeCocoRle(counts: number[], size: [number, number]): Mask | null {
  const [height, width] = size;
  if (
    typeof height !== "number" || !isFinite(height) || height <= 0 ||
    typeof width !== "number" || !isFinite(width) || width <= 0
  ) {
    return null;
  }

  const total = height * width;
  const data = new Uint8Array(total);
  let pos = 0;
  let isForeground = false;

  for (const run of counts) {
    if (typeof run !== "number" || !isFinite(run) || run < 0) return null;
    const end = Math.min(pos + run, total);
    if (isForeground) {
      data.fill(1, pos, end);
    }
    pos = end;
    isForeground = !isForeground;
  }

  // COCO uses column-major order; transpose to row-major for maskToBbox.
  const rowMajor = new Uint8Array(total);
  for (let col = 0; col < width; col++) {
    for (let row = 0; row < height; row++) {
      rowMajor[row * width + col] = data[col * height + row];
    }
  }

  return { data: rowMajor, width, height };
}
