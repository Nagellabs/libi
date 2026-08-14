/**
 * Playhead-aware "display overlay" resolver (Phase 9 of the overlay keyframe
 * feature). The gizmo + inspector must show the overlay's rect / opacity /
 * transform3d RESOLVED AT THE PLAYHEAD when the overlay is keyframed, instead of
 * the static base field — otherwise editing a keyframed overlay frames the gizmo
 * at the wrong spot.
 *
 * The golden rule: for a NON-keyframed overlay this is a NO-OP — it returns the
 * SAME overlay object reference, so downstream memoization / frame-isolation is
 * byte-identical to before this phase. The whole resolution is gated on
 * `overlayKeyframeTimes(overlay).length > 0`.
 *
 * Pure, no IO. The React wrapper (`hooks/preview/use-display-overlay.ts`) gates a
 * `usePlaybackFrame` subscription on the same "is animated" test.
 */
import type { Overlay } from "@/lib/engine/types";
import { overlayKeyframeTimes, snapshotValues } from "@/lib/overlays/keyframes";

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Return `overlay` with its `rect` / `opacity` / `transform3d` resolved at the
 * playhead (in seconds) when the overlay is keyframed; otherwise return the SAME
 * overlay reference unchanged. `null` in → `null` out.
 *
 * `t` is the overlay-local normalized progress
 * `clamp01((playheadSec - startTime) / duration)` — matching the renderer's
 * element-local timing, so the gizmo/inspector agree with what's drawn. A
 * playhead outside the overlay window clamps to the first/last keyframe value.
 */
export function overlayAtPlayhead(
  overlay: Overlay | null,
  playheadSec: number,
  fps: number,
): Overlay | null {
  void fps; // playheadSec is already in seconds; kept in the signature for call-site symmetry.
  if (!overlay) return overlay;
  if (overlayKeyframeTimes(overlay).length === 0) return overlay; // identity — no new object
  const duration = overlay.duration > 0 ? overlay.duration : 1;
  const t = clamp01((playheadSec - overlay.startTime) / duration);
  const snap = snapshotValues(overlay, t);
  return {
    ...overlay,
    rect: snap.rect,
    opacity: snap.opacity,
    transform3d: snap.transform3d,
  };
}
