/** Static preview renderer for a `CaptionStyle`.
 *
 *  Pure function — only calls methods on the passed `ctx`; no DOM lookups,
 *  no `document`, no rAF, no time/animation. A STYLE is a static look, so the
 *  thumbnail paints one settled sample word in the style's appearance
 *  (background plate → shadow → stroke → fill). Matches the painting order of
 *  `drawTextOverlay` in `lib/engine/overlay-renderer.ts` so the thumbnail looks
 *  like the real caption. Reveal/animation is NOT a style concern (Effects →
 *  Reveal) and is never drawn here.
 */

import type { CaptionStyle } from "@/lib/captions/types";

/** Round a rectangle path helper for background plates. */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const safe = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + safe, y);
  ctx.lineTo(x + w - safe, y);
  ctx.arcTo(x + w, y, x + w, y + safe, safe);
  ctx.lineTo(x + w, y + h - safe);
  ctx.arcTo(x + w, y + h, x + w - safe, y + h, safe);
  ctx.lineTo(x + safe, y + h);
  ctx.arcTo(x, y + h, x, y + h - safe, safe);
  ctx.lineTo(x, y + safe);
  ctx.arcTo(x, y, x + safe, y, safe);
  ctx.closePath();
}

/**
 * Draw ONE sample word centered in `size`, rendered in `style`'s static look.
 *
 * @param style      - The `CaptionStyle` to preview.
 * @param ctx        - A 2D rendering context to draw onto.
 * @param size       - The drawable area (`{ width, height }`).
 * @param sampleText - Optional text to show (default "Aa").
 */
export function renderStyleThumbnail(
  style: CaptionStyle,
  ctx: CanvasRenderingContext2D,
  size: { width: number; height: number },
  sampleText = "Aa",
): void {
  const { width, height } = size;

  // ── Font ──────────────────────────────────────────────────────────────────
  const fontSize = Math.round(height * 0.38);
  const weight = style.fontWeight ?? 700;
  const family = style.fontFamily ?? "sans-serif";
  ctx.font = `${weight} ${fontSize}px ${family}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const cx = width / 2;
  const cy = height / 2;

  // ── Background plate ──────────────────────────────────────────────────────
  if (style.background) {
    const measured = ctx.measureText(sampleText).width;
    const pad = style.background.padding ?? 8;
    const plateW = measured + pad * 2;
    const plateH = fontSize * 1.2 + pad * 2;
    const plateX = cx - plateW / 2;
    const plateY = cy - fontSize * 0.6 - pad;
    const prevFill = ctx.fillStyle;
    ctx.fillStyle = style.background.color;
    const radius = style.background.radius ?? 0;
    if (radius > 0) {
      roundRect(ctx, plateX, plateY, plateW, plateH, radius);
      ctx.fill();
    } else {
      ctx.fillRect(plateX, plateY, plateW, plateH);
    }
    ctx.fillStyle = prevFill;
  }

  // ── Shadow ────────────────────────────────────────────────────────────────
  if (style.shadow) {
    ctx.shadowColor = style.shadow.color;
    ctx.shadowBlur = style.shadow.blur;
    ctx.shadowOffsetX = style.shadow.dx ?? 0;
    ctx.shadowOffsetY = style.shadow.dy ?? 0;
  }

  // ── Stroke ────────────────────────────────────────────────────────────────
  if (style.stroke) {
    ctx.strokeStyle = style.stroke.color;
    ctx.lineWidth = style.stroke.width;
    ctx.strokeText(sampleText, cx, cy);
  }

  // ── Text fill ─────────────────────────────────────────────────────────────
  ctx.fillStyle = style.color;
  ctx.fillText(sampleText, cx, cy);

  // ── Reset shadow ──────────────────────────────────────────────────────────
  if (style.shadow) {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
}
