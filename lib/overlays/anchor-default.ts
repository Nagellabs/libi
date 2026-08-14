import type { CaptionAnchor } from "@/lib/captions/types";
import type { Overlay } from "@/lib/engine/types";

/**
 * The default 9-point placement anchor for an overlay kind.
 *
 * `anchor` is shared across ALL overlay kinds (see `BaseOverlay.anchor`). The
 * inspector Transform tab reads it for every kind; this is the single place that
 * decides the per-kind fallback when the overlay has none.
 *
 *  - `text` → "bottom-center" — captions live near the bottom of the frame.
 *  - every other kind → "mid-center" — box / image / video / code / three /
 *    tracked overlays default to the canvas centre.
 *
 * Centralizing this means inspector surfaces stop hardcoding the `?? "mid-center"`
 * literal (which silently mis-defaulted text). Read `lib/captions/types.ts` for
 * the canonical `CaptionAnchor` enum values.
 */
export function defaultAnchorForKind(kind: Overlay["kind"]): CaptionAnchor {
  return kind === "text" ? "bottom-center" : "mid-center";
}
