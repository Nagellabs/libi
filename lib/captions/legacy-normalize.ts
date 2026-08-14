// lib/captions/legacy-normalize.ts
//
// Lazy legacy-rect normalization on read (Milestone 3, Task 3.2). Any TEXT
// overlay MISSING an `anchor` predates the point-text rework: its `rect` was
// the authored placement. We normalize it to point text so all downstream
// readers see one model:
//   - anchor   = "mid-center"
//   - position = rect center
//   - fontSize = kept as-is
//   - maxWidthPct = set ONLY if the old rect was clearly a wrap box (the
//     content measured wider than rect.width ⇒ it WAS wrapping); else undefined
//     (single line, box hugs the text).
//
// Idempotent: an overlay that already has an `anchor` is returned unchanged
// (same reference). Uses an APPROXIMATE measurer — the client re-measures
// exactly at draw/edit time.
import { anchorPointOf } from "@/lib/captions/anchor";
import type { Overlay, TextOverlay } from "@/lib/engine/types";

/**
 * Normalize a single overlay. Non-text overlays and already-anchored text
 * overlays are returned unchanged (same reference). A legacy text overlay
 * (text, no anchor) is returned as a new object with `anchor` + `position`
 * (+ optional `maxWidthPct`) added. Pure given `measure`.
 *
 * Overloaded so a `TextOverlay` in yields a `TextOverlay` out — callers that
 * already narrowed to text keep their narrowing.
 */
export function normalizeLegacyTextOverlay(
  overlay: TextOverlay,
  frameWidth: number,
  measure: (line: string) => number,
): TextOverlay;
export function normalizeLegacyTextOverlay(
  overlay: Overlay,
  frameWidth: number,
  measure: (line: string) => number,
): Overlay;
export function normalizeLegacyTextOverlay(
  overlay: Overlay,
  frameWidth: number,
  measure: (line: string) => number,
): Overlay {
  if (overlay.kind !== "text") return overlay;
  const t = overlay as TextOverlay;
  // Idempotent: already migrated.
  if (t.anchor) return overlay;

  const position = anchorPointOf(t.rect, "mid-center");
  // A wrap box: the content measured wider than the authored rect width ⇒ it
  // WAS wrapping. Capture the wrap width as a fraction of the frame.
  const wasWrapping = measure(t.content) > t.rect.width;

  const next: TextOverlay = {
    ...t,
    anchor: "mid-center",
    position,
    ...(wasWrapping ? { maxWidthPct: t.rect.width / frameWidth } : {}),
  };
  return next;
}
