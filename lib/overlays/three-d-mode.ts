import type { Overlay, TextOverlay } from "@/lib/engine/types";
import { classifyTransform, resolveOverlayTransform } from "@/lib/engine/overlay-transform";

/**
 * Is this overlay in 3D mode (spatial-orientation controls + orbit gizmo active)?
 * `three` is inherently 3D. Otherwise read the explicit `place3d` flag; when the
 * flag is absent (legacy overlay), INFER it from real 3D state — text extrusion
 * (`threeD`) or an out-of-plane (`spatial`) transform — so pre-flag overlays
 * keep their gizmo. Once the user toggles, `place3d` is written and wins.
 */
export function isOverlayIn3dMode(overlay: Overlay): boolean {
  if (overlay.kind === "three") return true;
  if (overlay.place3d != null) return overlay.place3d;
  if (overlay.kind === "text" && overlay.threeD != null) return true;
  return classifyTransform(resolveOverlayTransform(overlay)) === "spatial";
}

/**
 * Does a TEXT overlay render through the 3D text instance (real 3D world space)
 * instead of the flat textured-quad? True when the user put it in 3D mode
 * (`place3d`) OR gave it extrusion (`threeD`). This is what makes Depth
 * (position.z, world units) actually move 3D text toward/away from the camera:
 * the quad path treats z as pixels with a ~negligible factor, which is why
 * "Make it 3D" + Depth did nothing before. A bare spatial transform (legacy, no
 * `place3d` flag) stays on the quad path to preserve its existing look.
 */
export function textUsesThreeInstance(overlay: Overlay): boolean {
  if (overlay.kind !== "text") return false;
  return overlay.place3d === true || overlay.threeD != null;
}

/** The 3D-text instance builder requires a `threeD` block; 3D-mode text without
 *  extrusion (`place3d: true`, no `threeD`) gets a flat (depth: 0) synthetic one
 *  at BUILD time only — never persisted, so the Extrude toggle (which reads
 *  overlay.threeD) stays independent / off. ONE helper for preview AND export so
 *  the two instance builders cannot drift into flat-vs-3D disagreement. */
export function withSynthesizedThreeD(o: TextOverlay): TextOverlay {
  return o.threeD ? o : { ...o, threeD: { depth: 0 } };
}
