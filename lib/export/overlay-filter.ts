/**
 * Shared ffmpeg overlay-compositing filter-graph primitives.
 *
 * The export backend (`lib/export/backends/ffmpeg-overlay.ts`) composites the
 * declarative overlay kinds (text via `drawtext`, image/video via the
 * `overlay` filter sourced from extra `-i` inputs) on top of a base video
 * label, sorted by `z`. This module factors out the per-overlay chain
 * emitters so the call site stays a thin assembler.
 *
 * Each emitter takes a `timeOffset` that is subtracted from each overlay's
 * `startTime` so its `enable` window lands at the right moment relative to the
 * base label. The export backend's base is the full clip starting at
 * composition t=0, so it passes `timeOffset = 0`; the parameter is kept
 * general so a windowed base (a clip starting partway into the composition)
 * can reuse the same emitters without duplicating the math.
 *
 * The emitters operate on a minimal STRUCTURAL overlay shape so both the
 * runtime `Overlay` (`lib/engine/types.ts`) and the `PersistedOverlay`
 * (`lib/composition/persistence.ts`) satisfy them without conversion.
 */

import { composeFont } from "@/lib/overlays/caption-style";
import { cssColorToFfmpeg } from "./backends/ffmpeg-overlay";

/** Minimal rect shape shared by runtime + persisted overlays. */
export interface FilterRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Structural shape of a text overlay sufficient to build its drawtext. */
export interface TextOverlayLike {
  kind: "text";
  startTime: number;
  duration: number;
  rect: FilterRect;
  opacity?: number;
  content: string;
  font: string;
  /** Structured font fields. These OVERRIDE the `font` shorthand — the canvas
   *  renderer resolves size via `overlay.fontSize ?? parseFontSizePx(composeFont(overlay))`
   *  (lib/engine/overlay-renderer.ts), so the drawtext path must fold them in
   *  the same way or preview and export disagree. */
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number | string;
  /** Optional uploaded font file id; the backend resolves it to an absolute
   *  path and passes it to `drawtextSpecFor` as `fontFilePath`. */
  fontFileId?: string;
  color: string;
  align: "left" | "center" | "right";
}

/** Structural shape of an image/video overlay sufficient to composite it. */
export interface AssetOverlayLike {
  kind: "image" | "video";
  startTime: number;
  duration: number;
  rect: FilterRect;
  opacity?: number;
  fileId: string;
  /** How the source fills the rect. Only meaningful for `kind: "video"` — the
   *  runtime `ImageOverlay` type has no `fit` field at all and always renders
   *  contain (`fitRect`, see `drawOverlayContent2D`'s "image" case). Absent on
   *  a video overlay defaults to "cover" — see below. */
  fit?: "cover" | "contain";
}

/** Parse a CSS font shorthand ("48px Inter", "bold 48px Inter") for size + family.
 *
 *  Accepts a fractional size ("28.5px Inter"). The earlier `(\d+)px` pattern
 *  matched the digits AFTER the decimal point on such a string — "28.5px Inter"
 *  parsed as size 5 — which `composeFont` can now produce from a fractional
 *  `fontSize`. */
export function parseFont(font: string): { size: number; family?: string } {
  const match = font.match(/(\d+(?:\.\d+)?)px\s+(.+)/);
  if (match) return { size: parseFloat(match[1]), family: match[2].trim() };
  return { size: 32 };
}

/** ffmpeg drawtext escapes: backslash, colon, apostrophe, percent. */
export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");
}

/**
 * Escape a filesystem path for use as a drawtext `fontfile=` option value.
 * Only `\` and `:` are option-delimiter-significant in the filter graph (a
 * colon separates drawtext options); apostrophes/percents are content-only
 * concerns, so they are left untouched here. macOS/Linux paths rarely contain
 * `:`, but escape defensively so a colon in the path can't split the option.
 */
export function escapeFontFilePath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

/** Horizontal-position expression honoring the overlay's text alignment. */
export function xExprForAlign(
  align: "left" | "center" | "right",
  x: number,
  width: number,
): string {
  switch (align) {
    case "center":
      return `${x}+(${width}-text_w)/2`;
    case "right":
      return `${x}+${width}-text_w`;
    case "left":
    default:
      return `${x}`;
  }
}

/**
 * Build the `enable='between(t,a,b)'` expression for an overlay, shifting its
 * timeline window by `timeOffset` so it lines up with the base label's time
 * origin and clamping the lower bound to 0 (the base never plays before t=0).
 */
export function enableExpr(
  startTime: number,
  duration: number,
  timeOffset: number,
): string {
  const localStart = Math.max(0, startTime - timeOffset);
  const localEnd = startTime + duration - timeOffset;
  return `between(t,${localStart},${localEnd})`;
}

/**
 * Emit a single `drawtext=...` filter spec (no input/output labels) for a
 * text overlay. `timeOffset` shifts the enable window to window-local time.
 *
 * When `fontFilePath` is supplied (an uploaded custom font's absolute path),
 * the spec emits `fontfile=<path>` and OMITS the `font=<family>` token —
 * ffmpeg uses one or the other. Otherwise it falls back to the shorthand's
 * named family via `font=<family>`.
 */
export function drawtextSpecFor(
  o: TextOverlayLike,
  timeOffset: number,
  fontFilePath?: string,
  /** Composition→target scale (targetWidth / compositionWidth). When the export
   *  composites at the target resolution (e.g. 4K), the fontsize and rect coords
   *  are scaled so drawtext rasterizes text NATIVELY at that resolution — crisp —
   *  instead of drawing at 1080 and lanczos-upscaling a soft frame. 1 = no scale. */
  scale = 1,
): string {
  // Resolve size/family the SAME way the canvas renderer does: structured
  // fields (fontSize/fontFamily/fontWeight) win over the `font` shorthand,
  // which callers routinely leave at its default. Reading `o.font` directly
  // rendered a `fontSize: 28` caption at the shorthand's 48px, so exported
  // text overflowed its rect and was clipped while the preview looked right.
  const { size, family } = parseFont(composeFont(o));
  const enable = enableExpr(o.startTime, o.duration, timeOffset);
  const safeText = escapeDrawtext(o.content);
  const fontPart = fontFilePath
    ? [`fontfile=${escapeFontFilePath(fontFilePath)}`]
    : family
      ? [`font=${family}`]
      : [];
  const parts = [
    `drawtext=text='${safeText}'`,
    `fontcolor=${cssColorToFfmpeg(o.color)}`,
    `fontsize=${Math.round(size * scale)}`,
    ...fontPart,
    // text_w (ffmpeg's measured text width) scales with the scaled fontsize, so
    // scaling x/width by the same factor keeps center/right alignment correct.
    `x=${xExprForAlign(o.align, Math.round(o.rect.x * scale), Math.round(o.rect.width * scale))}`,
    `y=${Math.round(o.rect.y * scale)}`,
    `alpha=${o.opacity ?? 1}`,
    `enable='${enable}'`,
  ];
  return parts.join(":");
}

/**
 * Emit the chain segment(s) that composite ONE image/video overlay onto a
 * base label:
 *   1. scale the asset input to its overlay rect dimensions, honoring the
 *      overlay's fit mode (cover = scale-up + centre-crop, matching
 *      `coverRect`; contain = scale-down + letterbox-less fit, matching
 *      `fitRect` — no `pad` because the overlay filter only draws the scaled
 *      pixels, it doesn't need to fill the rect with black),
 *   2. apply a partial-opacity alpha stage when `opacity < 1`, and
 *   3. overlay it at the rect origin, gated by its (time-shifted) enable window.
 *
 * The asset input stream is `[<inputIndex>:v]`; the result is written to
 * `[<outLabel>]`. The intermediate scaled label is uniquely keyed by
 * `scratchKey` so multiple overlays in one graph never collide.
 *
 * Fit default mirrors `drawOverlayContent2D` (lib/engine/overlay-renderer.ts):
 * a video overlay with no explicit `fit` defaults to "cover" (a video added
 * full-frame should fill the frame like a base scene); an image overlay has
 * no `fit` field at all and always renders contain. Since `o.fit` is simply
 * absent for an image overlay, defaulting on `o.kind` reproduces both.
 */
export function assetOverlaySegments(
  o: AssetOverlayLike,
  inputIndex: number,
  currentLabel: string,
  outLabel: string,
  scratchKey: string,
  timeOffset: number,
  /** Composition→target scale — see drawtextSpecFor. Scales the asset's rect so
   *  image/video overlays composite at the target resolution. 1 = no scale. */
  scale = 1,
): string[] {
  const enable = enableExpr(o.startTime, o.duration, timeOffset);
  const scaled = `ovl${scratchKey}`;
  const rw = Math.round(o.rect.width * scale);
  const rh = Math.round(o.rect.height * scale);
  const rx = Math.round(o.rect.x * scale);
  const ry = Math.round(o.rect.y * scale);

  const fit = o.fit ?? (o.kind === "video" ? "cover" : "contain");
  const scaleStage =
    fit === "cover"
      ? `scale=${rw}:${rh}:force_original_aspect_ratio=increase,crop=${rw}:${rh}`
      : `scale=${rw}:${rh}:force_original_aspect_ratio=decrease`;

  // Partial opacity needs a real alpha stage (overlay only honors an input's
  // alpha channel, so we must synthesize one); skip it at full opacity so the
  // common case adds no filter cost.
  const opacity = o.opacity ?? 1;
  const alphaStage = opacity < 1 ? `,format=rgba,colorchannelmixer=aa=${opacity}` : "";

  return [
    `[${inputIndex}:v]${scaleStage}${alphaStage}[${scaled}]`,
    `[${currentLabel}][${scaled}]overlay=${rx}:${ry}:enable='${enable}'[${outLabel}]`,
  ];
}
