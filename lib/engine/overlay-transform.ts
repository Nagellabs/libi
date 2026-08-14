import type { Transform3D } from "@/lib/engine/types";
import { IDENTITY_TRANSFORM3D, isIdentityTransform3d } from "@/lib/overlays/transform3d";

/** Orientation input: `transform3d` is the ONLY rotation storage; flip is the
 *  canonical `flipH`/`flipV` booleans. */
export interface OverlayOrientation {
  transform3d?: Transform3D;
  flipH?: boolean;
  flipV?: boolean;
}

/** Resolved flip state — read from the canonical `flipH`/`flipV` booleans. */
export interface ResolvedFlip { flipH: boolean; flipV: boolean; }

/** Flip is the canonical `flipH`/`flipV` booleans. */
export function resolveFlip(o: OverlayOrientation): ResolvedFlip {
  return { flipH: !!o.flipH, flipV: !!o.flipV };
}

/**
 * The single source of truth for an overlay's orientation. `transform3d` is the
 * ONLY rotation authority — in-plane spin lives on `rotation.z`. There is no
 * legacy `rotation` (degrees) field: it was deleted so a spun overlay can never
 * double-count its spin (dragging it used to ADD the legacy field on top of the
 * transform3d z). Flip is NOT part of the transform — it lives on
 * `flipH`/`flipV` and is read via `resolveFlip`. Bare input ⇒ identity.
 */
export function resolveOverlayTransform(o: OverlayOrientation): Transform3D {
  return o.transform3d ?? IDENTITY_TRANSFORM3D;
}

/**
 * Split a resolved transform into its out-of-plane 3D part (rotation.z zeroed)
 * and the in-plane screen-roll (`rotation.z`, radians).
 *
 * `rotation.z` is ALWAYS a 2D screen-roll about the overlay's rect center — it
 * is NEVER a 3D euler component. Applying it as a Canvas2D `ctx.rotate` AFTER
 * the (possibly perspective-projected) content is composited makes the in-plane
 * "Spin" render identically — same pivot, same direction (clockwise, the
 * Canvas2D convention) — across every path: planar 2D, the `three` overlay, 3D
 * text, and the spatial textured-quad. The 3D euler fed to three.js / the quad
 * projection uses only x (elevation) and y (angle). This is what keeps Spin
 * consistent (it used to roll CCW for 3D text via `scene.rotation.z`) and keeps
 * a tilted spatial quad's on-screen footprint STABLE while you spin (folding z
 * into the euler made the projected bbox swing wildly).
 */
export function splitScreenRoll(t: Transform3D): { spatial: Transform3D; rollRad: number } {
  const rollRad = t.rotation.z;
  if (!rollRad) return { spatial: t, rollRad: 0 };
  return {
    spatial: { position: t.position, rotation: { x: t.rotation.x, y: t.rotation.y, z: 0 } },
    rollRad,
  };
}

/** Rotate a screen point by `rad` (radians, clockwise) about `center`. */
export function rotatePointAround(
  px: number,
  py: number,
  cx: number,
  cy: number,
  rad: number,
): { x: number; y: number } {
  if (!rad) return { x: px, y: py };
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = px - cx, dy = py - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

export type TransformClass = "identity" | "planar" | "spatial";

/**
 * Classify a transform to pick the render path:
 *  - identity — no-op.
 *  - planar — only in-plane components (z-rotation, x/y-position).
 *    Representable as a Canvas2D affine; keeps the cheap path.
 *  - spatial — any out-of-plane component (rotation.x/y ≠ 0, or position.z ≠ 0).
 *    Needs perspective ⇒ the textured-quad path.
 */
export function classifyTransform(t: Transform3D): TransformClass {
  if (isIdentityTransform3d(t)) return "identity";
  if (t.rotation.x !== 0 || t.rotation.y !== 0 || t.position.z !== 0) return "spatial";
  return "planar";
}

export interface TransformBox { x: number; y: number; width: number; height: number; }

/** A minimal Canvas2D op (consumed by applyOverlayTransform). */
export type Canvas2DOp =
  | { kind: "translate"; x: number; y: number }
  | { kind: "rotate"; rad: number }
  | { kind: "scale"; x: number; y: number };

/**
 * The Canvas2D ops that realize a PLANAR transform (plus flip) about the box center:
 *   translate(cx + posX, cy + posY) · rotate(rot.z) · scale(sx, sy) · translate(-cx, -cy)
 * Returns [] only when the transform is identity AND there is no flip.
 * Spatial input ⇒ [] (caller routes to quad path). Legacy values (position 0)
 * reproduce the old center-anchored rotate+flip byte-for-byte.
 */
export function planarCanvas2DOps(t: Transform3D, box: TransformBox, flip: ResolvedFlip): Canvas2DOp[] {
  const cls = classifyTransform(t);
  const sx = flip.flipH ? -1 : 1;
  const sy = flip.flipV ? -1 : 1;
  if (cls === "spatial") return [];
  if (cls === "identity" && sx === 1 && sy === 1) return [];
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return [
    { kind: "translate", x: cx + t.position.x, y: cy + t.position.y },
    { kind: "rotate", rad: t.rotation.z },
    { kind: "scale", x: sx, y: sy },
    { kind: "translate", x: -cx, y: -cy },
  ];
}

/**
 * Inverse-map a screen point into the overlay's local (pre-transform) space for
 * a PLANAR transform — undoes the ops above in reverse order. Identity/spatial
 * ⇒ the point unchanged (spatial hit-test falls back to the rect upstream).
 */
export function inversePlanarPoint(
  t: Transform3D,
  box: TransformBox,
  flip: ResolvedFlip,
  px: number,
  py: number,
): { x: number; y: number } {
  if (classifyTransform(t) === "spatial") return { x: px, y: py };
  const sx = flip.flipH ? -1 : 1;
  const sy = flip.flipV ? -1 : 1;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // forward: translate(cx+posX, cy+posY) rotate(z) scale(sx,sy) translate(-cx,-cy)
  // inverse: translate(cx,cy) scale(1/sx,1/sy) rotate(-z) translate(-(cx+posX),-(cy+posY))
  let x = px - (cx + t.position.x);
  let y = py - (cy + t.position.y);
  const cos = Math.cos(-t.rotation.z), sin = Math.sin(-t.rotation.z);
  const rx = x * cos - y * sin;
  const ry = x * sin + y * cos;
  x = rx / sx; y = ry / sy;
  return { x: x + cx, y: y + cy };
}
