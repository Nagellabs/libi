import type { Overlay, TextOverlay } from "@/lib/engine/types";
import { isOverlayIn3dMode } from "@/lib/overlays/three-d-mode";

export type CaptionCanvasControl = "handles" | "gizmo";

/** Which on-canvas control an overlay shows: 2D box handles when flat, the
 *  orbit gizmo when in 3D mode (place3d / three / 3D text). */
export function overlayCanvasControl(overlay: Overlay): CaptionCanvasControl {
  return isOverlayIn3dMode(overlay) ? "gizmo" : "handles";
}

/** Back-compat wrapper for existing text call sites. */
export function captionCanvasControl(overlay: TextOverlay): CaptionCanvasControl {
  return overlayCanvasControl(overlay);
}
