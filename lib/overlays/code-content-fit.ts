import type { DrawContext, Overlay } from "@/lib/engine/types";

/** The union alpha-bbox of a code overlay's drawing, in the fn's own
 *  (rect-local, origin-at-0,0) coordinate space. */
export interface ContentBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A compiled code-overlay draw function (see `createDrawFunction`). */
export type CompiledDrawFn = (ctx: DrawContext) => void;

type CanvasFactory = (w: number, h: number) => OffscreenCanvas | HTMLCanvasElement;

/** Progress samples swept when probing an animated draw fn — the union of the
 *  ink bbox over these keeps animated content inside the fitted space. */
export const PROGRESS_SAMPLES = [0, 0.25, 0.5, 0.75, 1] as const;

// Stable, arbitrary timing the probe fabricates per sample so a draw fn that
// paces off frame/time/duration (rather than `progress`) still gets plausible
// values. The absolute numbers don't matter — sweeping progress 0→1 does.
const PROBE_FPS = 30;
const PROBE_DURATION_S = 1;

function defaultCanvasFactory(): CanvasFactory | null {
  if (typeof OffscreenCanvas !== "undefined") {
    return (w, h) => new OffscreenCanvas(w, h);
  }
  if (typeof document !== "undefined") {
    return (w, h) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      return c;
    };
  }
  return null;
}

/**
 * Contain-fit ops mapping a measured content box into the overlay rect: the
 * content scales UP when smaller than the rect and DOWN when larger, and the
 * result is centered. `scale = min(rectW/box.width, rectH/box.height)`.
 *
 * Applied by the renderer as `ctx.translate(dx, dy); ctx.scale(scale, scale)`
 * AFTER the rect clip + origin translate, so a point `p` in the fn's coordinate
 * space lands at `dx + p*scale`. A box equal to the rect ⇒ `{scale:1,dx:0,dy:0}`
 * (identity, byte-identical to the pre-fit render). A degenerate zero-size box
 * ⇒ identity too (the renderer never applies a zero blit).
 */
export function contentFitOps(
  box: ContentBox,
  rectW: number,
  rectH: number,
): { scale: number; dx: number; dy: number } {
  if (box.width <= 0 || box.height <= 0) return { scale: 1, dx: 0, dy: 0 };
  const scale = Math.min(rectW / box.width, rectH / box.height);
  const dx = (rectW - box.width * scale) / 2 - box.x * scale;
  const dy = (rectH - box.height * scale) / 2 - box.y * scale;
  return { scale, dx, dy };
}

/**
 * Probe a compiled code-overlay draw fn ONCE (off the hot render path) to find
 * the union alpha-bbox of everything it draws at the given rect size, over
 * PROGRESS_SAMPLES. Returns `null` when the fn draws nothing at every sample,
 * throws at every sample, or no real canvas is available (no `OffscreenCanvas`
 * and no injected factory) — in all those cases the renderer falls back to
 * identity (no scale), never a crash or a zero-size blit.
 *
 * The fn is invoked with the SAME context shape the renderer passes in
 * `case "code"` (rect-space `width`/`height`, element-local timing), so the
 * measured box matches what the renderer will actually paint.
 *
 * @param makeCanvas Injected canvas factory — required in environments without
 *   `OffscreenCanvas` (jsdom/node tests). Defaults to `OffscreenCanvas` / a DOM
 *   `<canvas>` in the browser.
 */
export function measureCodeContentBox(
  fn: CompiledDrawFn,
  rectW: number,
  rectH: number,
  makeCanvas?: CanvasFactory,
): ContentBox | null {
  const factory = makeCanvas ?? defaultCanvasFactory();
  if (!factory) return null;

  const w = Math.max(1, Math.floor(rectW));
  const h = Math.max(1, Math.floor(rectH));
  if (rectW <= 0 || rectH <= 0) return null;

  const canvas = factory(w, h);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) return null;

  const totalFrames = PROBE_DURATION_S * PROBE_FPS;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const progress of PROGRESS_SAMPLES) {
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    const time = progress * PROBE_DURATION_S;
    const frame = Math.round(progress * totalFrames);
    try {
      fn({
        ctx,
        width: rectW,
        height: rectH,
        fps: PROBE_FPS,
        totalFrames,
        frame,
        time,
        duration: PROBE_DURATION_S,
        progress,
        assets: {},
        renderScale: 1,
      });
    } catch {
      // A throwing sample contributes nothing — continue so a fn that only
      // fails at one progress can still measure from the others.
      ctx.restore();
      continue;
    }
    ctx.restore();

    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(0, 0, w, h).data;
    } catch {
      return null;
    }
    // Scan the alpha channel (every 4th byte) for the ink extent of THIS sample.
    for (let y = 0; y < h; y++) {
      const rowBase = y * w * 4;
      for (let x = 0; x < w; x++) {
        if (data[rowBase + x * 4 + 3] !== 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Batch-probe the plain `code` overlays in a composition, keyed by `overlay.id`.
 * Used by the export path (`render-entry`) and mirrored by the preview hook.
 *
 * ONLY plain `code` overlays are probed — tracked-`code` overlays render through
 * a separate renderer branch (their box is the resolved tracked bbox, not the
 * authored rect) and are intentionally NOT content-fit here.
 */
export function measureOverlayContentBoxes(
  overlays: Overlay[],
  compiledDrawFns: Record<string, CompiledDrawFn>,
  makeCanvas?: CanvasFactory,
): Record<string, ContentBox | null> {
  const out: Record<string, ContentBox | null> = {};
  for (const o of overlays) {
    if (o.kind !== "code") continue;
    const fn = compiledDrawFns[o.id];
    if (!fn) continue;
    out[o.id] = measureCodeContentBox(fn, o.rect.width, o.rect.height, makeCanvas);
  }
  return out;
}
