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
import { parseFontShorthand } from "@/lib/fonts/family";
import { quoteFilterValue, escapeDrawtext } from "@/lib/ffmpeg/filter-escape";
import { firstFamily } from "@/lib/fonts/bundled";
import type { CaptionAnchor } from "@/lib/captions/types";
import { layoutTextForExport, type ExportTextLayout } from "./text-export-layout";
import { PLATE_RADIUS_SQUARE_MAX } from "./overlay-predicates";

export { quoteFilterValue, escapeDrawtext };
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
  /** Line-height multiplier (renderer default 1.2) — sizes the text block the
   *  renderer centres vertically in `rect`. */
  lineHeight?: number;
  /** Optional uploaded font file id; the backend resolves it to an absolute
   *  path and passes it to `drawtextSpecFor` as `fontFilePath`. */
  fontFileId?: string;
  color: string;
  align: "left" | "center" | "right";
  /** Optional outline stroke (mirrors `TextOverlay.stroke` /
   *  `CaptionStroke` — {color, width}). `width` is in composition-pixel
   *  space, the same space as `fontSize`/`rect`, so it scales the same way. */
  stroke?: { color: string; width: number };
  /** Point-text placement. An overlay WITHOUT an anchor is an un-migrated
   *  (add_overlay / legacy) text whose wrap width comes from build-time
   *  normalization — see lib/export/text-export-layout.ts. */
  anchor?: CaptionAnchor;
  /** Wrap width as a fraction of the COMPOSITION width; unset ⇒ no wrap. */
  maxWidthPct?: number;
  /** Drop shadow — `blur` is the canvas `shadowBlur` (σ = blur / 2). */
  shadow?: { color: string; blur: number; dx?: number; dy?: number };
  /** Background plate around the whole text block. */
  background?: { color: string; padding?: number; radius?: number };
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

/** The family + CSS weight a text overlay renders with — structured fields
 *  over the shorthand, the same resolution as the canvas renderer. */
export function textFaceOf(o: TextOverlayLike): { family?: string; weight: number | string | undefined } {
  const composed = composeFont(o);
  const prefix = parseFontShorthand(composed)?.prefix ?? "";
  const weightToken = prefix.split(/\s+/).find((t) => /^(bold|normal|\d{3})$/i.test(t));
  return { family: parseFont(composed).family, weight: o.fontWeight ?? weightToken };
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

/** A shadow with at most this much canvas `shadowBlur` is drawn as drawtext's
 *  own hard shadow; σ = blur / 2 ≤ 0.5 px is indistinguishable from none. */
export const HARD_SHADOW_MAX_BLUR = 1;

/** Fold an overlay's opacity into an ffmpeg colour (for filters with no
 *  `alpha` option of their own — drawbox, a shadow layer's fill). */
export function ffmpegColorWithOpacity(color: string, opacity = 1): string {
  const c = cssColorToFfmpeg(color);
  if (opacity >= 1) return c;
  const hex = c.match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/);
  if (hex) {
    const a = hex[2] ? parseInt(hex[2], 16) / 255 : 1;
    const byte = Math.round(Math.max(0, Math.min(1, a * opacity)) * 255);
    return `#${hex[1]}${byte.toString(16).padStart(2, "0")}`;
  }
  return `${c}@${Math.max(0, Math.min(1, opacity))}`;
}

/** Split an ffmpeg colour (as `cssColorToFfmpeg` returns it) into an OPAQUE
 *  colour ffmpeg can parse — `#RRGGBB` or a named colour, which ffmpeg's own
 *  colour table resolves — and its alpha (0..1). */
export function splitFfmpegColor(ffColor: string): { rgb: string; alpha: number } {
  const hex = ffColor.match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/);
  if (hex) return { rgb: `#${hex[1]}`, alpha: hex[2] ? parseInt(hex[2], 16) / 255 : 1 };
  return { rgb: ffColor, alpha: 1 };
}

/** A shadow that needs a real blur (a layer + gblur), in TARGET px, or null
 *  when there is no shadow or drawtext's hard shadow reproduces it. The
 *  canvas blurs with a gaussian of σ = shadowBlur / 2 (HTML spec).
 *
 *  `color` is OPAQUE; `alpha` is the shadow colour's alpha × the overlay's
 *  opacity — the canvas multiplies the two (shadowColor alpha × globalAlpha).
 *  The layer applies it ONCE, after the blur: drawing the silhouettes in a
 *  translucent colour onto a transparent layer applied it twice (drawtext
 *  blends colour alpha into the alpha plane), so a 0.55 shadow came out at
 *  ≈0.30 — every bundled style at about half strength. */
export function blurredShadowOf(
  o: Pick<TextOverlayLike, "shadow" | "opacity">,
  scale = 1,
): { sigma: number; color: string; alpha: number } | null {
  if (!o.shadow || !(o.shadow.blur > HARD_SHADOW_MAX_BLUR)) return null;
  const { rgb, alpha } = splitFfmpegColor(cssColorToFfmpeg(o.shadow.color));
  return {
    sigma: Math.round((o.shadow.blur / 2) * scale * 100) / 100,
    color: rgb,
    alpha: Math.round(alpha * (o.opacity ?? 1) * 1000) / 1000,
  };
}

/** One `enable` expression covering every window — overlapping or touching
 *  windows merged, so a continuous caption track is ONE `between`. See
 *  MAX_ENABLE_SPANS for many disjoint windows. */
export function unionEnableExpr(
  windows: { startTime: number; duration: number }[],
  timeOffset: number,
): string {
  const spans = windows
    .map((w) => [Math.max(0, w.startTime - timeOffset), w.startTime + w.duration - timeOffset] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1e-6) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  if (merged.length === 0) return "0";
  // ffmpeg's expression evaluator rejects a long sum of `between`s (120 of
  // them failed to parse), so past a few spans one covering window is used:
  // still correct, it only stops skipping the gaps.
  if (merged.length > MAX_ENABLE_SPANS) {
    return `between(t,${merged[0][0]},${Math.max(...merged.map((m) => m[1]))})`;
  }
  return merged.map(([a, b]) => `between(t,${a},${b})`).join("+");
}

/** The most `between` terms one `enable` expression is built from. */
export const MAX_ENABLE_SPANS = 8;

/** Font selection for drawtext — see `drawtextSpecFor`. */
function fontParts(o: TextOverlayLike, fontFilePath?: string): string[] {
  if (fontFilePath) return [`fontfile=${quoteFilterValue(fontFilePath)}`];
  const { family } = parseFont(composeFont(o));
  // drawtext takes ONE fontconfig family, not a CSS list: the whole list put
  // its comma in the graph and ended the filter (exit 234).
  return family ? [`font=${quoteFilterValue(firstFamily(family))}`] : [];
}

/**
 * The per-line drawtexts of one text overlay — the fill, or (with `shadowOf`)
 * its blurred shadow's silhouette for the shadow layer.
 *
 * Each line is its own drawtext at the renderer's line top. drawtext's own
 * line pitch is the face's line height (145px for 120px Inter-Bold), not
 * lineHeight × fontSize, and its `text_w` is the WIDEST line's — so one
 * multi-line drawtext drifted line by line and mis-aligned every shorter
 * centred/right line.
 */
function lineDrawtexts(
  o: TextOverlayLike,
  layout: ExportTextLayout,
  timeOffset: number,
  fontFilePath: string | undefined,
  scale: number,
  shadowOf?: { dx: number; dy: number; originY: number },
): string[] {
  const enable = enableExpr(o.startTime, o.duration, timeOffset);
  const fontsize = Math.round(layout.fontSize * scale);
  const dx = shadowOf?.dx ?? 0;
  const dy = shadowOf?.dy ?? 0;
  // A shadow silhouette is an opaque white MASK (see shadowLayerSegments).
  const color = shadowOf ? "white" : cssColorToFfmpeg(o.color);
  // Outline stroke. The canvas preview draws it via `ctx.strokeText` with
  // `lineWidth = stroke.width`, which strokes CENTRED on the glyph outline, and
  // then fills the glyph over it (lib/engine/overlay-renderer.ts): only
  // width/2 is visible, all of it outside the glyph. freetype's `borderw` is
  // drawn entirely outside the glyph, so `borderw = width/2` reproduces the
  // visible outline — mapping 1:1 read about twice as thick as the preview
  // (QA 2026-09-18 N3). `width` is in composition-pixel space, same as
  // fontSize/rect, so the composition→target `scale` applies. Rounding can
  // floor a real (width>0) stroke to 0 — clamp to at least 1. The canvas
  // shadows the stroke too, so a shadow silhouette carries it in its colour.
  const strokePart =
    o.stroke && o.stroke.width > 0
      ? [
          `borderw=${Math.max(1, Math.round((o.stroke.width / 2) * scale))}`,
          `bordercolor=${shadowOf ? "white" : cssColorToFfmpeg(o.stroke.color)}`,
        ]
      : [];
  // A hard (unblurred) shadow is drawtext's own: offset in target px, and it
  // shadows the border as the canvas shadows the stroke.
  const hard = !shadowOf && o.shadow && !blurredShadowOf(o) ? o.shadow : undefined;
  const hardShadowPart = hard
    ? [
        `shadowx=${Math.round((hard.dx ?? 0) * scale)}`,
        `shadowy=${Math.round((hard.dy ?? 0) * scale)}`,
        `shadowcolor=${cssColorToFfmpeg(hard.color)}`,
      ]
    : [];
  return layout.lines.map((line, i) => {
    // Vertical placement, mirroring drawTextOverlay: the block is centred in
    // the rect and each line drawn with `textBaseline: "top"` — in Chromium
    // the top of the EM box, so the baseline sits fontSize × ascent /
    // (ascent + descent) below it (measured: 96.08 px for 120px Inter; its
    // hhea metrics are 0.969/0.242 em). drawtext's `font_a`/`font_d` are that
    // ascent/descent for the face actually loaded (font_d reads positive;
    // abs() guards a build that reports it signed), so placing the BASELINE
    // (`y_align=baseline`) there matches the preview for any font, uploaded
    // ones included.
    const lineTop = Math.round((layout.blockTop + i * layout.lineHeightPx + dy) * scale) - (shadowOf?.originY ?? 0);
    return [
      `drawtext=text=${quoteFilterValue(escapeDrawtext(line))}`,
      `fontcolor=${color}`,
      `fontsize=${fontsize}`,
      ...fontParts(o, fontFilePath),
      ...strokePart,
      ...hardShadowPart,
      // text_w scales with the scaled fontsize, so scaling x/width by the same
      // factor keeps center/right alignment correct.
      `x=${xExprForAlign(o.align, Math.round((o.rect.x + dx) * scale), Math.round(o.rect.width * scale))}`,
      `y_align=baseline`,
      `y=${lineTop}+${fontsize}*font_a/(font_a+abs(font_d))`,
      // The mask is opaque; the layer applies opacity with the shadow alpha.
      ...(shadowOf ? [] : [`alpha=${o.opacity ?? 1}`]),
      `enable='${enable}'`,
    ].join(":");
  });
}

/**
 * Emit the `drawtext=...` filter spec (no input/output labels) that FILLS a
 * text overlay — one drawtext per line, joined with "," into one linear chain.
 * `timeOffset` shifts the enable window to window-local time.
 *
 * `layout` is the preview's line layout (lib/export/text-export-layout.ts);
 * the export passes one computed with the real font and the composition width.
 * Without one the text is laid out unwrapped (hard breaks only).
 *
 * When `fontFilePath` is supplied (an uploaded custom font's absolute path, or
 * the bundled face the preview draws with — resolved by the ffmpeg-overlay
 * backend), the spec emits `fontfile=<path>` and OMITS the `font=<family>`
 * token — ffmpeg uses one or the other. Otherwise it falls back to the
 * shorthand's named family via `font=<family>` (a fontconfig lookup, which
 * can't express a weight). That lookup is not the preview's: a family libi
 * doesn't bundle (Montserrat, Impact, Georgia…) is whatever fontconfig finds —
 * on the bundled macOS ffmpeg, which has no fontconfig config, a default face —
 * while the browser and the export's line measure
 * (lib/export/text-measure-server.ts) each pick their own fallback. Glyphs and
 * widths can differ from the preview; bundled and uploaded fonts are exact.
 *
 * Size/family resolve the SAME way the canvas renderer does: structured fields
 * (fontSize/fontFamily/fontWeight) win over the `font` shorthand, which callers
 * routinely leave at its default. Reading `o.font` directly rendered a
 * `fontSize: 28` caption at the shorthand's 48px.
 *
 * A HARD shadow is part of this spec (drawtext's `shadowx/y`); a blurred one is
 * drawn on its own layer by `buildFilterChain` (see `shadowDrawtextSpecFor`),
 * and the background plate by `plateSpecFor`.
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
  layout: ExportTextLayout = layoutTextForExport(o, undefined),
): string {
  const specs = lineDrawtexts(o, layout, timeOffset, fontFilePath, scale);
  // An all-empty caption still has to be a valid filter between two labels.
  return specs.length > 0 ? specs.join(",") : "null";
}

/**
 * The silhouette of a text overlay's BLURRED shadow, for the shadow layer
 * `buildFilterChain` blurs: the same lines drawn as an opaque white mask,
 * offset by (dx, dy). Null when the overlay has no blurred shadow or no lines.
 */
export function shadowDrawtextSpecFor(
  o: TextOverlayLike,
  layout: ExportTextLayout,
  timeOffset: number,
  fontFilePath: string | undefined,
  scale = 1,
  /** Target-px Y the layer's top sits at (the layer is a cropped band). */
  originY = 0,
): string | null {
  const blurred = blurredShadowOf(o, scale);
  if (!blurred || !o.shadow) return null;
  const specs = lineDrawtexts(o, layout, timeOffset, fontFilePath, scale, {
    dx: o.shadow.dx ?? 0,
    dy: o.shadow.dy ?? 0,
    originY,
  });
  return specs.length > 0 ? specs.join(",") : null;
}

// Plates rounder than PLATE_RADIUS_SQUARE_MAX route to the chromium renderer
// (lib/export/overlay-predicates.ts#textNeedsBrowserRender).
export { PLATE_RADIUS_SQUARE_MAX };

/**
 * The background plate as one `drawbox` (no labels): the preview's single
 * plate around the whole block (widest line + padding × ink top…bottom +
 * padding), NOT drawtext's per-line `box`, which hugs each line separately.
 * Square-cornered — see PLATE_RADIUS_SQUARE_MAX (overlay-predicates.ts). Null when there is no plate.
 */
export function plateSpecFor(
  o: TextOverlayLike,
  layout: ExportTextLayout,
  timeOffset: number,
  scale = 1,
): string | null {
  const p = layout.plate;
  if (!p || layout.lines.length === 0) return null;
  const x = Math.round(p.x * scale);
  const y = Math.round(p.y * scale);
  const w = Math.round((p.x + p.width) * scale) - x;
  const h = Math.round((p.y + p.height) * scale) - y;
  if (w <= 0 || h <= 0) return null;
  const color = ffmpegColorWithOpacity(p.color, o.opacity ?? 1);
  return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=fill:enable='${enableExpr(o.startTime, o.duration, timeOffset)}'`;
}

/**
 * The rows (target px) a member's shadow can reach: its lines' boxes pushed
 * by dy, grown by a font size for ascenders/descenders and 3σ for the blur.
 */
export function shadowBandOf(
  o: TextOverlayLike,
  layout: ExportTextLayout,
  scale: number,
): { top: number; bottom: number } | null {
  const blurred = blurredShadowOf(o, scale);
  if (!blurred || !o.shadow || layout.lines.length === 0) return null;
  const dy = o.shadow.dy ?? 0;
  const reach = layout.fontSize * scale + 3 * blurred.sigma + Math.abs((o.stroke?.width ?? 0) * scale);
  const top = (layout.blockTop + dy) * scale - reach;
  const bottom = (layout.blockTop + layout.lines.length * layout.lineHeightPx + dy) * scale + reach;
  return { top, bottom };
}

/**
 * The segments of one shadow LAYER, over the frame rows `band` only:
 *   - a MASK: the band as gray, cleared to black, the members' silhouettes in
 *     opaque white (relative to the band's top), gaussian-blurred;
 *   - the shadow colour filling the band, the mask merged in as its alpha,
 *     scaled by the shadow's alpha × opacity — applied once, after the blur;
 *   - composited back at the band.
 * The blur runs on one 8-bit plane, and the blur and composite are enabled
 * only while a member is on screen (`enable`). One layer serves every member,
 * so a caption track pays for ONE blur per frame, not one per cue.
 * The colour is ffmpeg's to parse, so a named colour (`white`) fills as that
 * colour rather than black.
 */
export function shadowLayerSegments(
  silhouettes: string[],
  shadow: { sigma: number; color: string; alpha: number },
  band: { top: number; height: number },
  enable: string,
  inLabel: string,
  outLabel: string,
  key: string,
): string[] {
  const crop = `crop=iw:${band.height}:0:${band.top}`;
  const main = `shm${key}`;
  const maskSrc = `shs${key}`;
  const colorSrc = `shc${key}`;
  const mask = `shk${key}`;
  const fill = `shf${key}`;
  const layer = `shl${key}`;
  return [
    // `format=yuv420p` PINS the frame's format before the split. Without it
    // ffmpeg's format negotiation carried the mask branch's `format=gray`
    // back through split and crop to the base's `scale`, and the WHOLE export
    // came out grayscale.
    `[${inLabel}]format=yuv420p,split=3[${main}][${maskSrc}][${colorSrc}]`,
    `[${maskSrc}]${crop},format=gray,lut=c0=0,${silhouettes.join(",")},` +
      `gblur=sigma=${shadow.sigma}:steps=3:enable='${enable}'[${mask}]`,
    `[${colorSrc}]${crop},format=yuva420p,drawbox=c=${shadow.color}:t=fill:replace=1[${fill}]`,
    `[${fill}][${mask}]alphamerge,lut=a=val*${shadow.alpha}[${layer}]`,
    `[${main}][${layer}]overlay=0:${band.top}:enable='${enable}'[${outLabel}]`,
  ];
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
