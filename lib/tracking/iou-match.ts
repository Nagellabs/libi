export interface Box { x: number; y: number; w: number; h: number }

export function iou(a: Box, b: Box): number {
  const ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx2 = b.x + b.w, by2 = b.y + b.h;
  const ix1 = Math.max(a.x, b.x), iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  if (ix2 <= ix1 || iy2 <= iy1) return 0;
  const inter = (ix2 - ix1) * (iy2 - iy1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

export function matchByIoU(
  prev: Box,
  detections: Box[],
  opts: { minIou?: number } = {},
): Box | null {
  const minIou = opts.minIou ?? 0.1;
  let bestScore = -1;
  let best: Box | null = null;
  for (const d of detections) {
    const score = iou(prev, d);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  if (best === null || bestScore < minIou) return null;
  return best;
}
