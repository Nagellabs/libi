import type { Transform3D } from "@/lib/engine/types";
import type { ResolvedFlip } from "@/lib/engine/overlay-transform";

/**
 * Pure perspective-projection of a spatial overlay's textured quad — the single
 * source of truth shared by:
 *   - the WebGL renderer (`lib/engine/overlay-quad.ts`), which renders the same
 *     plane through an equivalent three.js camera, and
 *   - the editor hit-test + transform gizmo, which need to know WHERE the tilted
 *     quad lands on screen (a flat `overlay.rect` can't describe a 3D-rotated
 *     plane).
 *
 * The camera + plane constants below MUST stay in lockstep with
 * `lib/engine/overlay-quad.ts` (both import these). The math replicates a
 * `PerspectiveCamera(CAM_FOV, w/h)` at `(0,0,CAM_DIST)` looking at the origin,
 * with a `PlaneGeometry(planeH, planeH)` mesh scaled/rotated/translated by the
 * overlay's `transform3d`. At the IDENTITY transform the four projected corners
 * land exactly on the overlay's rect corners (verified in the unit test), so a
 * spatial overlay is visually continuous with the flat/planar path as a control
 * crosses 0.
 *
 * When the plane tilts enough that a corner swings toward/behind the camera, a
 * raw corner projection diverges (perspective divide → ±∞). `footprint` clips
 * the quad against the camera near-plane FIRST, so the returned screen polygon
 * is always the finite, on-screen region the quad actually covers.
 */

export const CAM_FOV = 50;
export const CAM_DIST = 2.2;
/** Clip everything closer than this (view-space, in front of the camera). */
const NEAR_EPS = 0.05;

export interface Point2D {
  x: number;
  y: number;
}

/** The plane extent in three world units (the plane is planeH × planeH). */
export function planeHeightWorld(): number {
  return 2 * Math.tan((CAM_FOV * Math.PI) / 180 / 2) * CAM_DIST;
}

/**
 * Convert a transform3d `position` (expressed in overlay/composition PIXELS,
 * same units the planar path uses) into the plane's world translation. The
 * plane fills the rect, so `rect.height` pixels span `planeH` world units — the
 * conversion is isotropic `planeH / rect.height` for both axes. Z keeps a small
 * depth factor (z-position is rarely used and has no pixel analogue).
 */
function positionToWorld(t: Transform3D, rectHeightPx: number) {
  const planeH = planeHeightWorld();
  const k = rectHeightPx > 0 ? planeH / rectHeightPx : 0;
  return {
    x: t.position.x * k,
    // Screen-y grows downward; world-y grows upward.
    y: -t.position.y * k,
    z: t.position.z * (k * 0.5),
  };
}

/** Rotate a vector by an intrinsic Euler XYZ rotation, matching three.js's
 *  `Matrix4.makeRotationFromEuler(order: "XYZ")`. */
function rotateEulerXYZ(
  v: { x: number; y: number; z: number },
  r: { x: number; y: number; z: number },
) {
  const c1 = Math.cos(r.x), s1 = Math.sin(r.x);
  const c2 = Math.cos(r.y), s2 = Math.sin(r.y);
  const c3 = Math.cos(r.z), s3 = Math.sin(r.z);
  const m00 = c2 * c3, m01 = -c2 * s3, m02 = s2;
  const m10 = c1 * s3 + s1 * s2 * c3, m11 = c1 * c3 - s1 * s2 * s3, m12 = -s1 * c2;
  const m20 = s1 * s3 - c1 * s2 * c3, m21 = s1 * c3 + c1 * s2 * s3, m22 = c1 * c2;
  return {
    x: m00 * v.x + m01 * v.y + m02 * v.z,
    y: m10 * v.x + m11 * v.y + m12 * v.z,
    z: m20 * v.x + m21 * v.y + m22 * v.z,
  };
}

export interface QuadRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ViewVert {
  x: number;
  y: number;
  z: number;
}

/** The four quad corners in VIEW space (camera at origin looking down -z). */
function quadViewCorners(rect: QuadRect, t: Transform3D, flip: ResolvedFlip): ViewVert[] {
  const w = rect.width;
  const h = rect.height;
  const aspect = w > 0 && h > 0 ? w / h : 1;
  const half = planeHeightWorld() / 2;
  const meshPos = positionToWorld(t, h);
  const local = [
    { x: -half, y: half },
    { x: half, y: half },
    { x: half, y: -half },
    { x: -half, y: -half },
  ];
  return local.map((c) => {
    const sx = c.x * (flip.flipH ? -1 : 1) * aspect;
    const sy = c.y * (flip.flipV ? -1 : 1);
    const r = rotateEulerXYZ({ x: sx, y: sy, z: 0 }, t.rotation);
    // world → view: camera at (0,0,CAM_DIST) looking -z ⇒ subtract camera pos.
    return { x: r.x + meshPos.x, y: r.y + meshPos.y, z: r.z + meshPos.z - CAM_DIST };
  });
}

/** Project a single VIEW-space vert to composition pixels. Caller guarantees
 *  `-v.z >= NEAR_EPS` (in front of the camera). */
function projectViewVert(v: ViewVert, rect: QuadRect): Point2D {
  const aspect = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 1;
  const f = 1 / Math.tan((CAM_FOV * Math.PI) / 180 / 2);
  const denom = -v.z;
  const ndcX = (f / aspect) * (v.x / denom);
  const ndcY = f * (v.y / denom);
  const glX = ((ndcX + 1) / 2) * rect.width;
  const glY = ((1 - ndcY) / 2) * rect.height;
  return { x: rect.x + glX, y: rect.y + glY };
}

/**
 * Project the four corners of a spatial overlay's quad into COMPOSITION-pixel
 * space (raw — NO near-plane clipping). Order [TL, TR, BR, BL]. Identity ⇒ the
 * rect's own corners. Diverges when a corner crosses the camera — use
 * `projectSpatialQuadFootprint` for anything interactive.
 */
export function projectSpatialQuadCorners(
  rect: QuadRect,
  t: Transform3D,
  flip: ResolvedFlip,
): [Point2D, Point2D, Point2D, Point2D] {
  const view = quadViewCorners(rect, t, flip);
  const out = view.map((v) => projectViewVert(v, rect)) as [Point2D, Point2D, Point2D, Point2D];
  return out;
}

/** Sutherland–Hodgman clip of a view-space polygon against `-z >= NEAR_EPS`
 *  (keep what's in front of the camera near-plane). */
function clipNear(poly: ViewVert[]): ViewVert[] {
  const out: ViewVert[] = [];
  const inside = (v: ViewVert) => -v.z >= NEAR_EPS;
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const prev = poly[(i + poly.length - 1) % poly.length];
    const curIn = inside(cur);
    const prevIn = inside(prev);
    if (curIn !== prevIn) {
      // Intersect edge prev→cur with plane z = -NEAR_EPS.
      const zPlane = -NEAR_EPS;
      const tt = (zPlane - prev.z) / (cur.z - prev.z);
      out.push({
        x: prev.x + (cur.x - prev.x) * tt,
        y: prev.y + (cur.y - prev.y) * tt,
        z: zPlane,
      });
    }
    if (curIn) out.push(cur);
  }
  return out;
}

/** Sutherland–Hodgman clip of a screen polygon against an axis-aligned rect —
 *  the GL canvas the quad renders into is exactly `rect`, so anything outside is
 *  not visible. The quad (fully in front of the camera after near-clip) projects
 *  to a convex polygon, so this intersection is clean. */
function clipToRect(poly: Point2D[], rect: QuadRect): Point2D[] {
  const x0 = rect.x, y0 = rect.y, x1 = rect.x + rect.width, y1 = rect.y + rect.height;
  // edges: keep points where inside(p) is true; intersect crossing edges.
  type Edge = { inside: (p: Point2D) => boolean; intersect: (a: Point2D, b: Point2D) => Point2D };
  const lerp = (a: Point2D, b: Point2D, tt: number): Point2D => ({
    x: a.x + (b.x - a.x) * tt,
    y: a.y + (b.y - a.y) * tt,
  });
  const edges: Edge[] = [
    { inside: (p) => p.x >= x0, intersect: (a, b) => lerp(a, b, (x0 - a.x) / (b.x - a.x)) },
    { inside: (p) => p.x <= x1, intersect: (a, b) => lerp(a, b, (x1 - a.x) / (b.x - a.x)) },
    { inside: (p) => p.y >= y0, intersect: (a, b) => lerp(a, b, (y0 - a.y) / (b.y - a.y)) },
    { inside: (p) => p.y <= y1, intersect: (a, b) => lerp(a, b, (y1 - a.y) / (b.y - a.y)) },
  ];
  let out = poly;
  for (const e of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const curIn = e.inside(cur);
      const prevIn = e.inside(prev);
      if (curIn !== prevIn) out.push(e.intersect(prev, cur));
      if (curIn) out.push(cur);
    }
    if (out.length === 0) break;
  }
  return out;
}

export interface QuadFootprint {
  /** On-screen polygon (composition px) the quad covers, clipped to the rect
   *  viewport. Empty when fully behind the camera / off-rect. */
  polygon: Point2D[];
  /** Axis-aligned bounds of `polygon` (composition px), always ⊆ the rect.
   *  Falls back to the flat rect when the polygon is degenerate. */
  bbox: QuadRect;
}

/**
 * The on-screen footprint of a spatial overlay's quad: near-plane clipped (view
 * space), projected, then clipped to the rect viewport (the GL canvas bounds).
 * This is what the hit-test and selection gizmo use — it always describes the
 * FINITE, visible region the tilted plane actually covers, even past edge-on.
 */
export function projectSpatialQuadFootprint(rect: QuadRect, t: Transform3D, flip: ResolvedFlip): QuadFootprint {
  const view = quadViewCorners(rect, t, flip);
  const nearClipped = clipNear(view);
  if (nearClipped.length < 3) {
    return { polygon: [], bbox: { ...rect } };
  }
  const projected = nearClipped.map((v) => projectViewVert(v, rect));
  const polygon = clipToRect(projected, rect);
  if (polygon.length < 3) {
    return { polygon: [], bbox: { ...rect } };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    polygon,
    bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
  };
}

/** Near-clipped + projected bbox of the spatial quad in COMPOSITION px, WITHOUT clamping
 *  to the rect viewport — so the returned bbox CAN exceed `rect` (used to expand the render
 *  buffer so tilted content isn't clipped). Falls back to `rect` when fully near-clipped. */
export function projectSpatialQuadBboxUnclamped(rect: QuadRect, t: Transform3D, flip: ResolvedFlip): QuadRect {
  const view = quadViewCorners(rect, t, flip);
  const nearClipped = clipNear(view);
  if (nearClipped.length < 3) return { ...rect };
  const pts = nearClipped.map((v) => projectViewVert(v, rect));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return { ...rect };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The polygon centroid of a set of points (composition px). */
export function quadCenter(corners: Point2D[]): Point2D {
  const n = corners.length || 1;
  let sx = 0, sy = 0;
  for (const c of corners) { sx += c.x; sy += c.y; }
  return { x: sx / n, y: sy / n };
}

/** Point-in-polygon (ray casting). Works for convex and mildly-concave polys. */
export function pointInQuad(p: Point2D, corners: Point2D[]): boolean {
  if (corners.length < 3) return false;
  let inside = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const xi = corners[i].x, yi = corners[i].y;
    const xj = corners[j].x, yj = corners[j].y;
    const intersect =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
