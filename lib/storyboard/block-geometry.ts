export type Rect = { x: number; y: number; w: number; h: number };

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Normalized (0..1) rect → pixel rect for a frame of (w,h). */
export function toPixelRect(r: Rect, w: number, h: number): Rect {
  return { x: r.x * w, y: r.y * h, w: r.w * w, h: r.h * h };
}

/** Pixel rect → normalized (0..1), clamped into the frame. */
export function toNormalizedRect(r: Rect, w: number, h: number): Rect {
  const x = clamp01(r.x / w);
  const y = clamp01(r.y / h);
  return { x, y, w: clamp01(r.w / w), h: clamp01(r.h / h) };
}
