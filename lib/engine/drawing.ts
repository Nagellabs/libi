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

/**
 * A least-recently-used cache bounded by entry count AND total bytes.
 *
 * Inside the sandbox worker these caches are module-level and shared by every
 * overlay body the worker runs, for the worker's whole life: unbounded, one
 * body calling `loadImage` on fresh `data:` URLs (or `drawSvg` on generated
 * strings) grows them without limit (Task 7 review, minor 9). An entry's bytes
 * are its key (a `data:` URL or an SVG string can be megabytes) plus, for an
 * image, its RGBA pixels.
 *
 * An evicted value is only DROPPED, never closed (fix round 1, ruling 3): the
 * cache hands the same bitmap to every body that asks, and a body routinely
 * keeps what `loadImage` gave it (`let logo = await loadImage(...)`), so the
 * cache never knows a bitmap is unreferenced — closing it detached a body's
 * image under it. The GC reclaims it once nothing holds it. Only a bitmap the
 * runtime itself owns and knows is unreferenced (a retired layer canvas, a
 * replaced entry's transferred images) is closed, and not here.
 */
class BoundedCache<V> {
  private readonly entries = new Map<string, { value: V; bytes: number }>();
  private bytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {}

  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    this.entries.delete(key); // most recently used goes last
    this.entries.set(key, e);
    return e.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** Cache `value` under `key`. One entry larger than the whole budget is not
   *  cached (and not evicted — the caller still holds it). */
  set(key: string, value: V, valueBytes = 0): void {
    const bytes = key.length * 2 + valueBytes;
    const prev = this.entries.get(key);
    if (prev) {
      // A second decode of the same key raced the first: dropped like any
      // evicted value.
      this.entries.delete(key);
      this.bytes -= prev.bytes;
    }
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const [oldestKey, oldest] = this.entries.entries().next().value!;
      this.entries.delete(oldestKey);
      this.bytes -= oldest.bytes;
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

/** Budgets for the caches below. Generous for any real body — 64 images at up
 *  to 256 MiB is thirty 1080p frames — and a hard ceiling for a runaway one. */
export const IMAGE_CACHE_MAX_ENTRIES = 64;
export const IMAGE_CACHE_MAX_BYTES = 256 * 1024 * 1024;
export const SVG_CACHE_MAX_ENTRIES = 64;
export const SVG_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const SVG_REFUSED_MAX_ENTRIES = 256;
export const SVG_REFUSED_MAX_BYTES = 4 * 1024 * 1024;

function pixelBytes(img: CanvasImageSource): number {
  const { width, height } = img as { width?: unknown; height?: unknown };
  return typeof width === "number" && typeof height === "number" ? width * height * 4 : 0;
}

const imageCache = new BoundedCache<CanvasImageSource>(IMAGE_CACHE_MAX_ENTRIES, IMAGE_CACHE_MAX_BYTES);
const svgCache = new BoundedCache<CanvasImageSource>(SVG_CACHE_MAX_ENTRIES, SVG_CACHE_MAX_BYTES);
/** SVG strings this environment already refused to rasterize (the sandbox
 *  worker — see `svgToImage`). A body that calls `drawSvg` every frame would
 *  otherwise re-attempt the decode every frame. */
const svgRefused = new BoundedCache<true>(SVG_REFUSED_MAX_ENTRIES, SVG_REFUSED_MAX_BYTES);

/** `data:<type>[;base64],<payload>` -> Blob, with no network and no DOM.
 *  Throws on a malformed URL; callers run it inside a promise. */
function dataUrlToBlob(src: string): Blob {
  const comma = src.indexOf(",");
  if (comma < 0) throw new Error(`Failed to load image: malformed data: URL (no comma) ${src.slice(0, 40)}`);
  const meta = src.slice(5, comma);
  const payload = src.slice(comma + 1);
  const isBase64 = /;base64$/i.test(meta);
  const type = meta.replace(/;base64$/i, "") || "application/octet-stream";
  const text = isBase64 ? atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return new Blob([bytes], { type });
}

function hasDomImage(): boolean {
  return typeof Image !== "undefined";
}

/**
 * Loads an image from the given source URL and caches it. Subsequent calls
 * with the same `src` return the cached image immediately.
 *
 * In a window this is an `<img>`. Inside the sandbox worker (spec A1) there is
 * no `Image` and no `fetch`: only a `data:` URL can be decoded there, through
 * `createImageBitmap`; the worker's own `loadImage` shim resolves piece files
 * before calling this (lib/sandbox/runtime/helpers.ts).
 */
export function loadImage(src: string): Promise<CanvasImageSource> {
  const cached = imageCache.get(src);
  if (cached) return Promise.resolve(cached);

  if (!hasDomImage()) {
    if (!/^data:/i.test(src)) {
      return Promise.reject(
        new Error(`Failed to load image: ${src} (no Image in this environment; only data: URLs decode here)`),
      );
    }
    // Decoded INSIDE the promise: a malformed URL (no comma, bad base64, a bad
    // `%` escape) makes `atob` / `decodeURIComponent` throw, and a synchronous
    // throw out of `loadImage` is one a body's `.catch` never sees.
    return new Promise<ImageBitmap>((resolve) => resolve(createImageBitmap(dataUrlToBlob(src)))).then((bitmap) => {
      imageCache.set(src, bitmap, pixelBytes(bitmap));
      return bitmap;
    });
  }

  return new Promise<CanvasImageSource>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imageCache.set(src, img, pixelBytes(img));
      resolve(img);
    };
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

/**
 * Converts an SVG string to a drawable image and caches it. In a window via an
 * `<img>` on a data URI.
 *
 * NOT in the sandbox worker. MEASURED 2026-09-23 on Chrome 147.0.7727.15: SVG is the
 * one image format Blink rasterizes through its document pipeline, which does
 * not exist off the main thread — `createImageBitmap` on an `image/svg+xml`
 * blob throws `InvalidStateError: The source image could not be decoded`
 * whether or not the `<svg>` carries width/height, and WebCodecs agrees
 * (`ImageDecoder.isTypeSupported("image/svg+xml")` is `false`). The attempt is
 * still made — once per SVG string, remembered after a refusal — so the day a
 * browser gains it this simply starts working; what a body must never be
 * handed is that opaque message, which names neither SVG nor a way out. Each
 * refusal is a FRESH error: the runtime tags a rejection with the overlay that
 * asked (lib/sandbox/runtime/helpers.ts), and a shared object would carry
 * whichever overlay asked last.
 */
function svgRefusal(): Error {
  return new Error(
    "drawSvg/svgToImage cannot run inside the overlay sandbox: this browser does not rasterize SVG off the main thread. Draw the shape with Canvas2D path calls (beginPath/moveTo/lineTo/arc/fill), or load a PNG or JPEG from this piece with loadImage().",
  );
}

export function svgToImage(svgString: string): Promise<CanvasImageSource> {
  const cached = svgCache.get(svgString);
  if (cached) return Promise.resolve(cached);

  if (!hasDomImage()) {
    if (svgRefused.has(svgString)) return Promise.reject(svgRefusal());
    return createImageBitmap(new Blob([svgString], { type: "image/svg+xml" })).then(
      (bitmap) => {
        svgCache.set(svgString, bitmap, pixelBytes(bitmap));
        return bitmap;
      },
      () => {
        svgRefused.set(svgString, true);
        throw svgRefusal();
      },
    );
  }

  const dataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;
  return new Promise<CanvasImageSource>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      svgCache.set(svgString, img, pixelBytes(img));
      resolve(img);
    };
    img.onerror = () => reject(new Error('Failed to load SVG'));
    img.src = dataUri;
  });
}

/** Test seam. */
export function __resetImageCachesForTests(): void {
  imageCache.clear();
  svgCache.clear();
  svgRefused.clear();
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
