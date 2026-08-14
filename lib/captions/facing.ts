import type { Transform3D } from "@/lib/engine/types";

/** 0 = edge-on (invisible), 1 = facing the camera. Roll (z) is ignored — it
 *  spins the text in-plane without ever hiding it. */
export function captionFacingFraction(t: Transform3D): number {
  const f = Math.abs(Math.cos(t.rotation.x) * Math.cos(t.rotation.y));
  return Math.max(0, Math.min(1, f));
}

/** Past ~70° of tilt the overlay is hard to read / near-invisible. Non-blocking
 *  signal, kind-agnostic (any overlay with a transform3d). */
export function isOverlayNearEdgeOn(t: Transform3D, threshold = 0.34): boolean {
  return captionFacingFraction(t) < threshold;
}

/** @deprecated use isOverlayNearEdgeOn — kept for one release. */
export const isCaptionNearEdgeOn = isOverlayNearEdgeOn;
