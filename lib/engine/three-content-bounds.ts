import type { OverlayRect } from "@/lib/engine/types";

/** Normalized content bounds inside a three viewport — fractions in [0,1],
 *  origin top-left, as projected from the 3D scene. */
export interface ContentBoundsNDC { minX: number; minY: number; maxX: number; maxY: number; }

/** Map normalized content bounds (within the rect viewport) to a composition-space
 *  rect. Returns null for a degenerate/empty box so callers fall back to the full
 *  rect. Clamps to the viewport so the result never exceeds the rect. */
export function contentBoundsToRect(rect: OverlayRect, b: ContentBoundsNDC | null): OverlayRect | null {
  if (!b) return null;
  const minX = Math.max(0, Math.min(1, b.minX));
  const minY = Math.max(0, Math.min(1, b.minY));
  const maxX = Math.max(0, Math.min(1, b.maxX));
  const maxY = Math.max(0, Math.min(1, b.maxY));
  const w = (maxX - minX) * rect.width;
  const h = (maxY - minY) * rect.height;
  if (w < 2 || h < 2) return null; // degenerate → caller uses full rect
  return { x: rect.x + minX * rect.width, y: rect.y + minY * rect.height, width: w, height: h };
}

/** Expand a projected content rect so neither side is smaller than `minW`×`minH`
 *  (composition px), keeping the box centered on the content centroid.
 *
 *  Why: the gizmo box hugs the projected 3D content. When the content foreshortens
 *  (pitch) or recedes (depth), that projection collapses to a sliver — e.g. a
 *  110×12 css box — leaving the move body + resize handles stacked in an ungrabbable
 *  strip. Flooring the box to a usable minimum keeps the gizmo interactive while
 *  still hugging the text when the content is reasonably sized.
 *
 *  No viewport clamp — tilted/extruded 3D content legitimately renders beyond its
 *  base rect, and the selection box must wrap what is actually drawn. The `viewport`
 *  param is retained for signature stability (callers pass the base overlay rect).
 *  Pure; inputs are not mutated. */
export function floorContentRect(
  content: OverlayRect,
  _viewport: OverlayRect,
  minW: number,
  minH: number,
): OverlayRect {
  const w = Math.max(content.width, minW);
  const h = Math.max(content.height, minH);
  const cx = content.x + content.width / 2;
  const cy = content.y + content.height / 2;
  // Center the floored box on the content centroid. No viewport clamp — a tilted/
  // extruded 3D overlay's footprint can exceed its base rect, and the box must
  // wrap what's drawn.
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

export interface ExpandedRender { expanded: OverlayRect; offsetX: number; offsetY: number; }

/** Grow `rect` to cover the (possibly out-of-[0,1]) projected content NDC bounds, clamped
 *  so neither side exceeds `cap`x the base side. `offsetX/Y` = where the base rect sits
 *  inside the expanded buffer (composition px), for the camera view-offset. Pure. */
export function expandRectToContentBounds(
  rect: OverlayRect, b: ContentBoundsNDC | null, cap = 4,
): ExpandedRender {
  if (!b) return { expanded: { ...rect }, offsetX: 0, offsetY: 0 };
  let loX = Math.max(-(cap - 1), Math.min(0, b.minX));
  let hiX = Math.min(cap, Math.max(1, b.maxX));
  let loY = Math.max(-(cap - 1), Math.min(0, b.minY));
  let hiY = Math.min(cap, Math.max(1, b.maxY));
  // Snap expansion to a coarse grid (1/8-of-rect steps) so tiny rotation changes
  // don't resize the GL buffer every frame → fewer redraws, no box-size flicker.
  // Applied BEFORE the cap-clamp so the cap still bounds the result.
  const Q = 0.125;
  loX = Math.floor(loX / Q) * Q;
  hiX = Math.ceil(hiX / Q) * Q;
  loY = Math.floor(loY / Q) * Q;
  hiY = Math.ceil(hiY / Q) * Q;
  let x = rect.x + loX * rect.width;
  let y = rect.y + loY * rect.height;
  let width = (hiX - loX) * rect.width;
  let height = (hiY - loY) * rect.height;
  // clamp each side to cap x base, re-centering on the content centroid
  const maxW = cap * rect.width;
  const maxH = cap * rect.height;
  if (width > maxW) { x += (width - maxW) / 2; width = maxW; }
  if (height > maxH) { y += (height - maxH) / 2; height = maxH; }
  const expanded = { x, y, width, height };
  return { expanded, offsetX: rect.x - expanded.x, offsetY: rect.y - expanded.y };
}

/** Like contentBoundsToRect but WITHOUT clamping to the viewport — the returned rect can
 *  exceed `rect` (for the content-hugging outline on overflowing 3D content). null on
 *  degenerate (<2px). Pure. */
export function contentBoundsToRectUnclamped(rect: OverlayRect, b: ContentBoundsNDC | null): OverlayRect | null {
  if (!b) return null;
  const w = (b.maxX - b.minX) * rect.width;
  const h = (b.maxY - b.minY) * rect.height;
  if (w < 2 || h < 2) return null;
  return { x: rect.x + b.minX * rect.width, y: rect.y + b.minY * rect.height, width: w, height: h };
}

/** Axis-aligned bounding rect covering both inputs. Pure. */
export function unionRect(a: OverlayRect, b: OverlayRect): OverlayRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/** Map a new content (display) rect back to the underlying viewport rect,
 *  preserving the content↔viewport offset+scale relationship.
 *
 *  Given the new display rect `d`, the old display rect `c`, and the old
 *  viewport rect `v`, returns the new viewport rect such that the content sits
 *  at the same proportional offset inside the (scaled) viewport. A pure move of
 *  `d` shifts `v` by the same delta; a uniform 2× resize of `d` scales `v` 2×. */
export function mapContentRectToViewport(d: OverlayRect, c: OverlayRect, v: OverlayRect): OverlayRect {
  const sx = c.width ? d.width / c.width : 1;
  const sy = c.height ? d.height / c.height : 1;
  // viewport scales by the same factor; its origin keeps the content offset.
  const width = v.width * sx;
  const height = v.height * sy;
  // offset of content inside viewport, scaled, re-anchored to the new content origin.
  const offX = (v.x - c.x) * sx;
  const offY = (v.y - c.y) * sy;
  return { x: d.x + offX, y: d.y + offY, width, height };
}
