/** Canvas drawing helpers for the Libi composition engine */

/** Style options for drawTextBlock */
export interface TextStyle {
  font?: string;
  color?: string;
  align?: CanvasTextAlign;
}

/** Direction for linear gradients */
export type GradientDirection = 'horizontal' | 'vertical' | 'diagonal';

// ---------------------------------------------------------------------------
// Image / SVG caching
// ---------------------------------------------------------------------------

const imageCache = new Map<string, HTMLImageElement>();
const svgCache = new Map<string, HTMLImageElement>();

/**
 * Loads an image from the given source URL and caches it. Subsequent calls
 * with the same `src` return the cached image immediately.
 */
export function loadImage(src: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(src);
  if (cached) return Promise.resolve(cached);

  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imageCache.set(src, img);
      resolve(img);
    };
    img.onerror = (_e) => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

/**
 * Converts an SVG string to an HTMLImageElement via a data URI and caches it.
 * Subsequent calls with the same SVG string return the cached image.
 */
export function svgToImage(svgString: string): Promise<HTMLImageElement> {
  const cached = svgCache.get(svgString);
  if (cached) return Promise.resolve(cached);

  const dataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      svgCache.set(svgString, img);
      resolve(img);
    };
    img.onerror = (_e) => reject(new Error('Failed to load SVG'));
    img.src = dataUri;
  });
}

// ---------------------------------------------------------------------------
// Drawing functions
// ---------------------------------------------------------------------------

/**
 * Renders an SVG string to the canvas at the specified position and size.
 *
 * Uses the SVG image cache so that repeated renders of the same SVG across
 * frames do not re-parse the SVG.
 */
export async function drawSvg(
  ctx: CanvasRenderingContext2D,
  svgString: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  const img = await svgToImage(svgString);
  ctx.drawImage(img, x, y, width, height);
}

/**
 * Draws a rounded rectangle, optionally filled and/or stroked.
 */
export function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  fill?: string,
  stroke?: string,
): void {
  const r = Math.min(radius, w / 2, h / 2);

  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();

  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

/**
 * Draws a linear gradient rectangle.
 *
 * @param colors - Array of CSS color strings distributed evenly
 * @param direction - Gradient direction. Default: 'vertical'
 */
export function drawGradient(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  colors: string[],
  direction: GradientDirection = 'vertical',
): void {
  if (colors.length === 0) return;

  const x0 = x,
    y0 = y;
  let x1 = x,
    y1 = y;

  switch (direction) {
    case 'horizontal':
      x1 = x + w;
      break;
    case 'vertical':
      y1 = y + h;
      break;
    case 'diagonal':
      x1 = x + w;
      y1 = y + h;
      break;
  }

  const gradient = ctx.createLinearGradient(x0, y0, x1, y1);

  for (let i = 0; i < colors.length; i++) {
    const stop = colors.length === 1 ? 0 : i / (colors.length - 1);
    gradient.addColorStop(stop, colors[i]);
  }

  ctx.fillStyle = gradient;
  ctx.fillRect(x, y, w, h);
}

/**
 * Draws a block of text with automatic word wrapping.
 *
 * @param text - The text to render
 * @param x - Left x coordinate of the text block
 * @param y - Top y coordinate of the first line baseline
 * @param maxWidth - Maximum width before wrapping
 * @param lineHeight - Vertical distance between lines in pixels
 * @param style - Optional font, color, and alignment settings
 */
export function drawTextBlock(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  style?: TextStyle,
): void {
  if (style?.font) ctx.font = style.font;
  if (style?.color) ctx.fillStyle = style.color;
  if (style?.align) ctx.textAlign = style.align;

  const words = text.split(' ');
  let line = '';
  let currentY = y;

  for (let i = 0; i < words.length; i++) {
    const testLine = line ? `${line} ${words[i]}` : words[i];
    const metrics = ctx.measureText(testLine);

    if (metrics.width > maxWidth && line) {
      ctx.fillText(line, x, currentY);
      line = words[i];
      currentY += lineHeight;
    } else {
      line = testLine;
    }
  }

  // Draw the remaining text
  if (line) {
    ctx.fillText(line, x, currentY);
  }
}

/**
 * Draws a circle, optionally filled and/or stroked.
 */
export function drawCircle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  fill?: string,
  stroke?: string,
): void {
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();

  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}
