import { placeBoxAtAnchor } from "@/lib/captions/anchor";
import type { CaptionAnchor } from "@/lib/captions/types";
// wrapText lives in lib/overlays/caption-style.ts (already exported); the
// overlay-renderer merely re-imports it. Signature: (measure, text, maxWidth).
import { wrapText } from "@/lib/overlays/caption-style";

export interface LayoutInput {
  content: string;
  position: { x: number; y: number };
  anchor: CaptionAnchor;
  fontSizePx: number;
  /** Line-height multiplier (default 1.2). */
  lineHeight: number;
  /** 0..1 of frameWidth; undefined ⇒ no wrap (single line). */
  maxWidthPct?: number;
  frameWidth: number;
  /** Background padding included in the box. */
  padding?: number;
}

/**
 * The one box-computing function. Wraps the content to `maxWidthPct` (or never,
 * hugging the text), measures the widest line, then places the derived box so
 * its `anchor` point sits at `position`. Pure given `measure`.
 */
export function layoutTextOverlay(
  input: LayoutInput,
  measure: (line: string) => number,
): { rect: { x: number; y: number; width: number; height: number }; lines: string[] } {
  const wrapWidth = input.maxWidthPct ? input.frameWidth * input.maxWidthPct : Infinity;
  const lines = wrapText(measure, input.content, wrapWidth);
  const pad = input.padding ?? 0;
  const w = (lines.length ? Math.max(...lines.map(measure)) : 0) + pad * 2;
  const h = lines.length * input.fontSizePx * input.lineHeight + pad * 2;
  const rect = placeBoxAtAnchor(input.position, input.anchor, w, h);
  return { rect, lines };
}

/**
 * Pure geometry for a caption's background plate. The plate hugs the TEXT INK
 * box + padding — `inkTop`/`inkBottom` are the absolute composition-Y bounds of
 * the actually-drawn glyphs (from `measureText` actual-bounding-box metrics in
 * the caller). Earlier versions sized the plate to `lineHeight`/`fontSize`,
 * which over-reserved space below the glyphs (the "background overflows under
 * the caption" bug) — e.g. for 88px bold serif the real glyph descent is ~70px,
 * not 88. Extracted + exported so the geometry is unit-testable without a
 * canvas. `widest` is the measured width of the widest line (px).
 */
export function captionPlateRect(params: {
  rectX: number;
  rectWidth: number;
  inkTop: number;
  inkBottom: number;
  widest: number;
  pad: number;
  align: "left" | "center" | "right";
}): { x: number; y: number; width: number; height: number } {
  const { rectX, rectWidth, inkTop, inkBottom, widest, pad, align } = params;
  const width = widest + pad * 2;
  const height = Math.max(0, inkBottom - inkTop) + pad * 2;
  const x =
    align === "center"
      ? rectX + rectWidth / 2 - width / 2
      : align === "right"
        ? rectX + rectWidth - width
        : rectX;
  const y = inkTop - pad;
  return { x, y, width, height };
}
