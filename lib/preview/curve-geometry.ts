/**
 * Pure geometry for the keyframe curve editor (Phase 6).
 *
 * All functions here are dependency-free math over a UNIT graph: the easing
 * curve is drawn in a 1×1 space where x = normalized time (0→1) and y = eased
 * value (0→1, y-up). The SVG viewport is a padded box; this module converts
 * between the two spaces and samples curves into polyline points, so the React
 * component stays a thin renderer. Unit-tested in
 * `__tests__/unit/preview/curve-geometry.test.ts`.
 */

import { cubicBezier, resolveEasing, EASING_PRESETS } from "@/lib/engine/easing-registry";
import type { EasingFunction } from "@/lib/engine/animation";

/** A point in SVG pixel space. */
export interface SvgPoint {
  x: number;
  y: number;
}

/** The four cubic-bézier control values `cubic-bezier(x1,y1,x2,y2)`. */
export type BezierTuple = [number, number, number, number];

/** The default ease-in-out handles (matches the registry's `ease-in-out`). */
export const DEFAULT_BEZIER: BezierTuple = [0.42, 0, 0.58, 1];

/** SVG box geometry — the outer viewport plus symmetric inner padding. The
 *  unit graph (0..1 × 0..1) maps into the padded inner rect. */
export interface GraphBox {
  /** Outer SVG width/height (viewBox units). */
  width: number;
  height: number;
  /** Inner padding on every side (viewBox units). */
  pad: number;
}

/** Map a unit point (ux,uy ∈ [0,1], y-up) to SVG pixel coords (y-down). */
export function unitToSvg(ux: number, uy: number, box: GraphBox): SvgPoint {
  const innerW = box.width - box.pad * 2;
  const innerH = box.height - box.pad * 2;
  return {
    x: box.pad + ux * innerW,
    // y-up in unit space → y-down in SVG: uy=0 sits at the bottom.
    y: box.pad + (1 - uy) * innerH,
  };
}

/** Map an SVG pixel point back to unit space (y-up). Inverse of `unitToSvg`. */
export function svgToUnit(px: number, py: number, box: GraphBox): SvgPoint {
  const innerW = box.width - box.pad * 2;
  const innerH = box.height - box.pad * 2;
  const ux = innerW > 0 ? (px - box.pad) / innerW : 0;
  const uyDown = innerH > 0 ? (py - box.pad) / innerH : 0;
  return { x: ux, y: 1 - uyDown };
}

/** Clamp a number to [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Parse a `cubic-bezier(x1,y1,x2,y2)` literal into its tuple. Returns null when
 * the string isn't a well-formed cubic-bezier (4 finite numbers).
 */
export function parseCubicBezier(easing: string): BezierTuple | null {
  const m = /^cubic-bezier\(\s*([^)]+)\s*\)$/i.exec(easing.trim());
  if (!m) return null;
  const parts = m[1].split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || !parts.every((n) => Number.isFinite(n))) return null;
  return [parts[0], parts[1], parts[2], parts[3]];
}

/**
 * Resolve an easing spec to the bézier tuple to seed the draggable handles.
 * - a preset id with a `bezier` → that bezier
 * - a preset id that is `fn`-only (bounce/elastic) → null (no handles)
 * - a `cubic-bezier(...)` literal → its parsed tuple
 * - anything else → DEFAULT_BEZIER
 */
export function bezierForEasing(easing: string | undefined): BezierTuple | null {
  if (!easing) return DEFAULT_BEZIER;
  const preset = EASING_PRESETS.find((p) => p.id === easing);
  if (preset) {
    if (preset.bezier) return [...preset.bezier] as BezierTuple;
    // fn-only preset (bounce/elastic) — not bézier-representable.
    return null;
  }
  const parsed = parseCubicBezier(easing);
  if (parsed) return parsed;
  return DEFAULT_BEZIER;
}

/** Format a bézier tuple as a `cubic-bezier(...)` literal (short, stable). */
export function formatCubicBezier(b: BezierTuple): string {
  const r = (n: number) => {
    // Trim to 3 decimals, drop trailing zeros.
    const s = n.toFixed(3);
    return s.replace(/\.?0+$/, "");
  };
  return `cubic-bezier(${r(b[0])},${r(b[1])},${r(b[2])},${r(b[3])})`;
}

/**
 * Sample an easing FUNCTION into `samples+1` unit points across x ∈ [0,1].
 * Used for fn-only presets (bounce/elastic) whose y overshoots [0,1]. The
 * caller maps these to SVG via `unitToSvg`.
 */
export function sampleEasingFn(fn: EasingFunction, samples = 48): SvgPoint[] {
  const pts: SvgPoint[] = [];
  const n = Math.max(1, samples);
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    pts.push({ x, y: fn(x) });
  }
  return pts;
}

/**
 * Sample the easing identified by `easing` into unit points. For a bézier
 * preset / literal this walks the cubic-bezier fn (y is a function of eased x,
 * matching how the runtime evaluates it); for an fn-only preset it walks `fn`.
 * Never throws — falls back to linear via `resolveEasing`.
 */
export function sampleEasing(easing: string | undefined, samples = 48): SvgPoint[] {
  const bezier = bezierForEasing(easing);
  const fn: EasingFunction = bezier ? cubicBezier(...bezier) : resolveEasing(easing);
  return sampleEasingFn(fn, samples);
}

/** Build an SVG path `d` string from unit points mapped through the box. */
export function polylinePath(points: SvgPoint[], box: GraphBox): string {
  if (points.length === 0) return "";
  return points
    .map((p, i) => {
      const s = unitToSvg(p.x, p.y, box);
      return `${i === 0 ? "M" : "L"}${s.x.toFixed(2)},${s.y.toFixed(2)}`;
    })
    .join(" ");
}

/**
 * The two handle anchor points (endpoints of the cubic) and control points, in
 * SVG space, for the draggable Custom curve. P0=(0,0), P3=(1,1) are fixed; the
 * control points are (x1,y1) and (x2,y2). Returned as { p0, c1, c2, p3 }.
 */
export function bezierHandlesSvg(
  b: BezierTuple,
  box: GraphBox,
): { p0: SvgPoint; c1: SvgPoint; c2: SvgPoint; p3: SvgPoint } {
  return {
    p0: unitToSvg(0, 0, box),
    c1: unitToSvg(b[0], b[1], box),
    c2: unitToSvg(b[2], b[3], box),
    p3: unitToSvg(1, 1, box),
  };
}
