// lib/captions/persist-rect.ts
//
// Server-side derived-rect recompute for point-text overlays (Milestone 3,
// Task 3.1). When a TEXT overlay carries BOTH an `anchor` and a `position`,
// its `rect` is DERIVED — the point-text placement is the source of truth and
// the rect is a stand-in used for export x/y + hit-test fallback. We recompute
// it here on save via `layoutTextOverlay`.
//
// The server has NO canvas, so we use an APPROXIMATE measurer
// (chars * fontSizePx * 0.5). The client re-measures exactly at draw/edit time
// against the real font; the persisted rect is only an approximation.
import { layoutTextOverlay } from "@/lib/captions/layout";
import type { PersistedOverlay } from "@/lib/composition/persistence";

type TextOverlay = Extract<PersistedOverlay, { kind: "text" }>;

const DEFAULT_FONT_SIZE = 48;
const DEFAULT_LINE_HEIGHT = 1.2;

/**
 * Recompute the derived `rect` for a single overlay. Returns the new rect when
 * the overlay is point-text (text + anchor + position); otherwise returns the
 * overlay's existing rect unchanged. Pure given `measure`.
 */
export function recomputeTextOverlayRect(
  overlay: PersistedOverlay,
  frameWidth: number,
  measure: (line: string) => number,
): { x: number; y: number; width: number; height: number } {
  if (overlay.kind !== "text") return overlay.rect;
  const t = overlay as TextOverlay;
  if (!t.anchor || !t.position) return t.rect;

  const fontSizePx = t.fontSize ?? DEFAULT_FONT_SIZE;
  const lineHeight = t.lineHeight ?? DEFAULT_LINE_HEIGHT;
  const { rect } = layoutTextOverlay(
    {
      content: t.content,
      position: t.position,
      anchor: t.anchor,
      fontSizePx,
      lineHeight,
      maxWidthPct: t.maxWidthPct,
      frameWidth,
    },
    measure,
  );
  return rect;
}
