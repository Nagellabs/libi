/** opentype.js → THREE.Shape[] → ExtrudeGeometry — the PREMIUM 3D-text path.
 *
 *  BROWSER-SAFE: this module is reached through the client bundle (the preview
 *  hook → browser-deps), so it must NOT import `node:fs` (the chunking context
 *  can't bundle external node modules) and must NOT default-import opentype.js
 *  (its ESM build `dist/opentype.mjs` has no default export — Turbopack errors).
 *  `import * as opentype` + `opentype.parse(bytes)` on raw bytes (the
 *  loadSync/load helpers are broken in this opentype.js build). The node-only
 *  fs-based loader lives in `extrude-node.ts` (imported by tests only).
 *
 *  This file provides font parsing from raw bytes / a URL fetch, glyph-outline →
 *  THREE.Shape conversion (with counter holes), and an ExtrudeGeometry mesh
 *  builder with a per-cache-key geometry cache. three is lazy-imported so this
 *  module is GL-free until buildExtrudedMesh is called.
 *
 *  COORDINATE NOTE: opentype's getPath emits glyph outlines with +y DOWN (screen
 *  space). THREE wants +y UP, so we negate y when building shapes — text reads
 *  upright in the scene. */

import * as opentype from "opentype.js";
import * as THREE from "three";
import { geometryCacheKey } from "@/lib/engine/text-3d/font-resolve";

type AnyTHREE = typeof import("three");

// NOTE on the static `three` import: this module is only ever reached through
// the lazy-imported 3D-text build path (build-text-three.ts, itself behind the
// preview hook's `await import(...)`), so importing three statically here does
// NOT bloat the base bundle — it stays inside the existing lazy boundary. The
// builder still accepts an injected THREE param for symmetry with three-overlay.ts.

// ─── Font loading (cached by url) ───────────────────────────────────────────────

const fontByUrl = new Map<string, Promise<opentype.Font>>();

/** Parse a font from raw bytes (browser-safe). opentype.parse needs an
 *  ArrayBuffer; a Uint8Array is converted by slicing its backing buffer to the
 *  view's exact window (a bare `.buffer` can include unrelated bytes when the
 *  view is a slice of a pooled buffer). */
export function parseFontBytes(bytes: ArrayBuffer | Uint8Array): opentype.Font {
  const arrayBuffer =
    bytes instanceof Uint8Array
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      : bytes;
  return opentype.parse(arrayBuffer);
}

/** Parse a font from a URL (browser-side; the preview hook fetches /fonts/3d/<file>).
 *  Cached per url so SSE refetches don't re-fetch the font. */
export function loadFontFromUrl(url: string): Promise<opentype.Font> {
  const cached = fontByUrl.get(url);
  if (cached) return cached;
  const p = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`font fetch ${url} → ${res.status}`);
    return parseFontBytes(await res.arrayBuffer());
  })();
  fontByUrl.set(url, p);
  void p.catch(() => fontByUrl.delete(url));
  return p;
}

// ─── Glyph outlines → THREE.Shape[] ────────────────────────────────────────────

interface Pt {
  x: number;
  y: number;
}

/** A single closed contour as a flat list of (sampled) points, retaining the raw
 *  opentype commands so we can rebuild it as a Shape or a hole path. */
interface Contour {
  commands: opentype.PathCommand[];
  /** Signed area (shoelace) — sign distinguishes outer outline vs counter hole. */
  area: number;
  /** Approx polygon for point-in-contour containment tests. */
  poly: Pt[];
}

/** Shoelace signed area of a polygon (CCW positive). */
function signedArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Coarse polygon approximation of a contour (line endpoints only) for
 *  containment + winding. Good enough to nest holes; the real curvature is
 *  preserved in the Shape via quadraticCurveTo/bezierCurveTo. */
function approxPoly(commands: opentype.PathCommand[]): Pt[] {
  const pts: Pt[] = [];
  for (const c of commands) {
    if (c.type === "Z") continue;
    // Every non-Z command carries an endpoint (x,y) — flip y to THREE space.
    pts.push({ x: c.x, y: -c.y });
  }
  return pts;
}

/** Even-odd point-in-polygon. */
function pointInPoly(pt: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const intersect =
      a.y > pt.y !== b.y > pt.y &&
      pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y || 1e-9) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Split an opentype glyph path's commands into closed contours (split on M). */
function splitContours(commands: opentype.PathCommand[]): Contour[] {
  const contours: Contour[] = [];
  let current: opentype.PathCommand[] = [];
  for (const c of commands) {
    if (c.type === "M" && current.length > 0) {
      contours.push(finishContour(current));
      current = [];
    }
    current.push(c);
  }
  if (current.length > 0) contours.push(finishContour(current));
  return contours.filter((c) => c.poly.length >= 3);
}

function finishContour(commands: opentype.PathCommand[]): Contour {
  const poly = approxPoly(commands);
  return { commands, area: signedArea(poly), poly };
}

/** Replay a contour's opentype commands onto a THREE Path (or Shape, which
 *  extends Path). y is flipped to THREE space (+y up). */
function applyContour(target: import("three").Path, commands: opentype.PathCommand[]): void {
  for (const c of commands) {
    switch (c.type) {
      case "M":
        target.moveTo(c.x, -c.y);
        break;
      case "L":
        target.lineTo(c.x, -c.y);
        break;
      case "Q":
        target.quadraticCurveTo(c.x1, -c.y1, c.x, -c.y);
        break;
      case "C":
        target.bezierCurveTo(c.x1, -c.y1, c.x2, -c.y2, c.x, -c.y);
        break;
      case "Z":
        target.closePath();
        break;
    }
  }
}

/** A representative interior-ish point of a contour (its centroid) for the
 *  containment test that nests holes inside their parent outline. */
function centroid(poly: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

/**
 * Convert text to an array of THREE.Shape, one per outer glyph outline, with
 * counter contours (e.g. the hole in "o"/"e"/"a") attached as `.holes`. Returns
 * `[]` for whitespace-only text. `size` is the font size in world units.
 */
export function glyphShapesFor(font: opentype.Font, text: string, size: number): import("three").Shape[] {
  const path = font.getPath(text, 0, 0, size);
  const contours = splitContours(path.commands as opentype.PathCommand[]);
  if (contours.length === 0) return [];

  // Outer outlines have one winding sign; counters have the opposite. The dominant
  // sign (by total |area|) is the outline sign.
  let outerSign = 0;
  {
    let pos = 0;
    let neg = 0;
    for (const c of contours) {
      if (c.area >= 0) pos += c.area;
      else neg += -c.area;
    }
    outerSign = pos >= neg ? 1 : -1;
  }

  const outers = contours.filter((c) => Math.sign(c.area) === outerSign && c.area !== 0);
  const holes = contours.filter((c) => Math.sign(c.area) !== outerSign && c.area !== 0);

  const shapes: import("three").Shape[] = [];
  for (const outer of outers) {
    const shape = new THREE.Shape();
    applyContour(shape, outer.commands); // Shape extends Path — replay directly.
    for (const hole of holes) {
      if (pointInPoly(centroid(hole.poly), outer.poly)) {
        const holePath = new THREE.Path();
        applyContour(holePath, hole.commands);
        shape.holes.push(holePath);
      }
    }
    shapes.push(shape);
  }
  return shapes;
}

// ─── ExtrudeGeometry mesh ──────────────────────────────────────────────────────

const geometryCache = new Map<string, import("three").ExtrudeGeometry>();

/** Cache-owned (shared) geometries. A geometry in here is referenced by the
 *  module-level `geometryCache` and may be in use by MULTIPLE overlay instances
 *  that share a glyph (same font|glyph|depth|bevel). An instance's dispose() must
 *  NOT free these — doing so corrupts every other instance still using the buffer
 *  and hands a dead geometry to future builds. Only the cache owns their lifetime. */
const cachedGeometries = new WeakSet<object>();

/** Tag a geometry as cache-owned. Returns it for chaining. */
export function markGeometryCached<T extends import("three").BufferGeometry>(geometry: T): T {
  cachedGeometries.add(geometry as unknown as object);
  return geometry;
}

/** True when a geometry is owned by the shared geometry cache (must not be freed
 *  by a per-instance dispose). */
export function isCachedGeometry(geometry: unknown): boolean {
  return geometry != null && typeof geometry === "object" && cachedGeometries.has(geometry as object);
}

export interface ExtrudeOpts {
  depth: number;
  bevel?: number;
  frontColor?: string;
  sideColor?: string;
}

/**
 * Build an extruded mesh for the given glyph shapes. Two materials (front face +
 * extruded sides) when colors differ, else one. Geometry keeps the font's
 * intrinsic x/y (left side bearing + baseline at 0); only depth is centered.
 * Cached by `geometryCacheKey`. Returns a Mesh.
 */
export function buildExtrudedMesh(
  THREE: AnyTHREE,
  shapes: import("three").Shape[],
  opts: ExtrudeOpts,
  cacheKey?: string,
): import("three").Mesh {
  const depth = opts.depth;
  const bevel = opts.bevel ?? 0;

  let geometry: import("three").ExtrudeGeometry;
  const cached = cacheKey ? geometryCache.get(cacheKey) : undefined;
  if (cached) {
    geometry = cached;
  } else {
    geometry = new THREE.ExtrudeGeometry(shapes, {
      depth,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: bevel > 0 ? 2 : 0,
      steps: 1,
    });
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    if (bb) {
      // Center DEPTH only. X keeps the opentype left side bearing and Y keeps
      // the baseline at 0 (getPath emitted the outline pen-positioned at the
      // origin) — per-glyph bbox centering here is what destroyed the shared
      // baseline and made pen-advance layout misplace glyph centers.
      const cz = (bb.min.z + bb.max.z) / 2;
      geometry.translate(0, 0, -cz);
    }
    if (cacheKey) {
      markGeometryCached(geometry);
      geometryCache.set(cacheKey, geometry);
    }
  }

  const front = new THREE.MeshStandardMaterial({
    color: opts.frontColor ?? "#ffffff",
    metalness: 0.2,
    roughness: 0.45,
  });
  const side = new THREE.MeshStandardMaterial({
    color: opts.sideColor ?? opts.frontColor ?? "#cccccc",
    metalness: 0.2,
    roughness: 0.6,
  });
  // ExtrudeGeometry emits group 0 = front+back caps, group 1 = sides.
  const mesh = new THREE.Mesh(geometry, [front, side]);
  return mesh;
}

export { geometryCacheKey };
