import type { Overlay, TextOverlay } from "@/lib/engine/types";

/**
 * A caption is "flat" (plain 2D) only when it has NEITHER 3D extrusion
 * (`threeD`) NOR the universal "Make it 3D" gate (`place3d`). A `place3d` caption
 * is intentionally tilted in space even without extrusion, so its out-of-plane
 * rotation (pitch/yaw) must be preserved on save.
 */
export function isCaptionFlat(overlay: TextOverlay): boolean {
  return overlay.threeD == null && !overlay.place3d;
}

/**
 * Flatten ANY overlay back to the 2D invariant: clear the `place3d` gate, drop
 * text extrusion (`threeD`), and zero the out-of-plane transform (pitch
 * `rotation.x`, yaw `rotation.y`, depth `position.z`). In-plane spin
 * (`rotation.z`) and position X/Y are preserved. No-op when already flat
 * with an identity-ish 3D component.
 */
export function flattenOverlay<T extends Overlay>(overlay: T): T {
  const t = overlay.transform3d;
  const hasSpatial = !!t && (t.rotation.x !== 0 || t.rotation.y !== 0 || t.position.z !== 0);
  const hasThreeD = overlay.kind === "text" && (overlay as TextOverlay).threeD != null;
  if (!overlay.place3d && !hasSpatial && !hasThreeD) return overlay;

  const next: T = { ...overlay, place3d: false };
  if (overlay.kind === "text") (next as unknown as TextOverlay).threeD = undefined;
  if (t) {
    next.transform3d = {
      position: { ...t.position, z: 0 },
      rotation: { ...t.rotation, x: 0, y: 0 },
    };
  }
  return next;
}

/**
 * Flat-caption guardrail. NO-OP for a 3D caption — either extruded
 * (`threeD != null`) OR "Make it 3D" on (`place3d`) — so a tilted caption keeps
 * its pitch/yaw. Only zeros stray `transform3d.rotation.x/y` when the caption is
 * TRULY FLAT (no `threeD` AND no `place3d`). Never drops `threeD`, never sets
 * `place3d`, never zeros `position.z`. Called on every text caption on save (see
 * `lib/composition/persistence.ts`).
 */
export function flattenCaption(overlay: TextOverlay): TextOverlay {
  if (!isCaptionFlat(overlay)) return overlay;
  const t = overlay.transform3d;
  if (!t || (t.rotation.x === 0 && t.rotation.y === 0)) {
    return overlay.threeD == null ? overlay : { ...overlay, threeD: undefined };
  }
  return { ...overlay, threeD: undefined, transform3d: { ...t, rotation: { ...t.rotation, x: 0, y: 0 } } };
}
