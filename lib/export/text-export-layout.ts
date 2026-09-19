/**
 * The text layout the ffmpeg export draws, computed the way the PREVIEW lays a
 * caption out (`drawTextOverlay`, lib/engine/overlay-renderer.ts), so drawtext
 * can reproduce it line for line. Pure: the font measure is injected — the
 * export passes a real one (`lib/export/text-measure-server.ts`, the same font
 * file drawtext loads); tests and callers without one get the approximation.
 *
 * What the preview does, and what this mirrors:
 *   - Wrap: `wrapText(measure, content, frameWidth × maxWidthPct)` — no
 *     `maxWidthPct` means no wrap, and hard `\n` breaks are honoured either
 *     way. `frameWidth` is the COMPOSITION width (manifest), never the export
 *     size: a 4K export wraps in composition space and scales.
 *   - An un-anchored text (add_overlay, legacy) gets its `maxWidthPct` from
 *     `normalizeLegacyTextOverlay` at BUILD time. The ffmpeg export reads the
 *     persisted overlays and never builds, so it applies the same
 *     normalization here, with the same APPROXIMATE measure — that measure
 *     decides WHETHER the preview wraps, so using the real font for the
 *     decision would wrap captions the preview draws on one line.
 *   - The block of `lines × fontSize × lineHeight` is centred in `rect`
 *     (clamped to its top when it overflows).
 *   - The background plate is `captionPlateRect` over the lines' INK bounds.
 */
import { wrapText, composeFont } from "@/lib/overlays/caption-style";
import { captionPlateRect } from "@/lib/captions/layout";
import { approxLegacyMeasure, normalizeLegacyTextOverlay } from "@/lib/captions/legacy-normalize";
import type { CaptionAnchor } from "@/lib/captions/types";
import type { TextOverlay } from "@/lib/engine/types";

/** Font measure for one text overlay, in composition px. */
export interface TextMeasurer {
  /** Advance width — what the preview's `ctx.measureText(s).width` returns. */
  width(s: string): number;
  /** Ink bounds relative to a `textBaseline: "top"` line origin, as Chromium
   *  reports them (`actualBoundingBoxAscent` / `...Descent`): ink spans
   *  `lineTop − ascent … lineTop + descent`. */
  ink(s: string): { ascent: number; descent: number };
}

/** The fields the layout reads. Structural, so the runtime `Overlay` and the
 *  persisted overlay both fit. */
export interface TextLayoutInput {
  content: string;
  font: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number | string;
  lineHeight?: number;
  align: "left" | "center" | "right";
  rect: { x: number; y: number; width: number; height: number };
  anchor?: CaptionAnchor;
  maxWidthPct?: number;
  background?: { color: string; padding?: number; radius?: number };
}

export interface ExportTextLayout {
  lines: string[];
  fontSize: number;
  lineHeightPx: number;
  /** Composition-Y of the first line's top (`textBaseline: "top"`). */
  blockTop: number;
  /** The background plate in composition px, when the overlay has one. */
  plate?: { x: number; y: number; width: number; height: number; radius: number; color: string };
}

/** The renderer's font size: structured `fontSize` over the shorthand. */
export function layoutFontSize(o: TextLayoutInput): number {
  const m = composeFont(o).match(/(\d+(?:\.\d+)?)px/);
  return o.fontSize ?? (m ? parseFloat(m[1]) : 48);
}

/** A font-free measurer: the build-time approximation (0.5 em per char) for
 *  width, and the renderer's own fallback ink box (the em from the line top)
 *  when a canvas reports no ink metrics. */
export function approxTextMeasurer(fontSize: number): TextMeasurer {
  return {
    width: (s) => s.length * fontSize * 0.5,
    ink: () => ({ ascent: 0, descent: fontSize }),
  };
}

/** The wrap width fraction the preview draws `o` with — its own `maxWidthPct`,
 *  or for an un-anchored text the one build-time normalization would give it. */
export function effectiveMaxWidthPct(o: TextLayoutInput, frameWidth: number): number | undefined {
  if (o.anchor) return o.maxWidthPct;
  const text = { ...o, kind: "text" } as unknown as TextOverlay;
  return normalizeLegacyTextOverlay(text, frameWidth, approxLegacyMeasure(text)).maxWidthPct;
}

/**
 * Lay a text overlay out the way the preview does. `frameWidth` undefined means
 * "don't wrap" (no composition to wrap against) — hard breaks still split.
 */
export function layoutTextForExport(
  o: TextLayoutInput,
  frameWidth: number | undefined,
  measurer?: TextMeasurer,
): ExportTextLayout {
  const fontSize = layoutFontSize(o);
  const m = measurer ?? approxTextMeasurer(fontSize);
  const pct = frameWidth !== undefined ? effectiveMaxWidthPct(o, frameWidth) : undefined;
  const wrapWidth = pct && frameWidth !== undefined ? frameWidth * pct : Infinity;
  const lines = wrapText((s) => m.width(s), o.content, wrapWidth);
  const lineHeightPx = fontSize * (o.lineHeight ?? 1.2);
  const blockTop = o.rect.y + Math.max(0, (o.rect.height - lines.length * lineHeightPx) / 2);

  let plate: ExportTextLayout["plate"];
  if (o.background) {
    let widest = 0;
    let inkTop = Infinity;
    let inkBottom = -Infinity;
    lines.forEach((line, i) => {
      const lineTop = blockTop + i * lineHeightPx;
      const probe = line || " ";
      widest = Math.max(widest, m.width(probe));
      const { ascent, descent } = m.ink(probe);
      inkTop = Math.min(inkTop, lineTop - ascent);
      inkBottom = Math.max(inkBottom, lineTop + descent);
    });
    if (!Number.isFinite(inkTop)) {
      inkTop = blockTop;
      inkBottom = blockTop + fontSize;
    }
    const rect = captionPlateRect({
      rectX: o.rect.x,
      rectWidth: o.rect.width,
      inkTop,
      inkBottom,
      widest,
      pad: o.background.padding ?? 8,
      align: o.align,
    });
    plate = { ...rect, radius: o.background.radius ?? 0, color: o.background.color };
  }

  return { lines, fontSize, lineHeightPx, blockTop, plate };
}
