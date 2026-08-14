/** 2.5D faux-extrusion — the FALLBACK 3D-text path when no real font file is
 *  available (name-only family, unsupported format). Stacks N Canvas2D-texture
 *  text planes along z, darkening toward the back, to fake depth without an
 *  ExtrudeGeometry. Reuses makeCanvasTextClass (the same synchronous Canvas2D
 *  text the three-overlay runtime uses). */

import type { makeCanvasTextClass } from "@/lib/engine/canvas-text";

type AnyTHREE = typeof import("three");
type CanvasTextClass = ReturnType<typeof makeCanvasTextClass>;

/**
 * `layers` evenly-spaced z offsets spanning [0, depth], ordered BACK→FRONT
 * (ascending). `layers===1` → `[0]`. `depth===0` → all zeros. Pure.
 */
export function fauxLayerOffsets(depth: number, layers: number): number[] {
  const n = Math.max(1, Math.floor(layers));
  if (n === 1) return [0];
  if (depth === 0) return new Array(n).fill(0);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push((depth * i) / (n - 1));
  }
  return out;
}

export interface FauxOpts {
  content: string;
  /** CSS family applied to every plane's text. */
  font?: string;
  /** Front-face color. */
  color: string;
  depth: number;
  /** Color of the receding extrusion; back layers blend toward it. Absent ⇒
   *  a darkened version of `color`. */
  sideColor?: string;
  /** Number of stacked planes. Absent ⇒ a sensible default by depth. */
  layers?: number;
  /** Karaoke highlight color. When set, a hidden front plane is rasterized in
   *  this color AT BUILD TIME and toggled by the group's `userData.setColor`
   *  (visibility swap — NEVER a per-frame re-raster). */
  highlightColor?: string;
}

/** Set the plane's opacity via its (transparent) CanvasText material. */
function setPlaneOpacity(plane: import("three").Object3D, alpha: number): void {
  const mat = (plane as unknown as { material?: unknown }).material;
  const apply = (m: unknown) => {
    const mm = m as { transparent?: boolean; opacity?: number } | null;
    if (!mm) return;
    mm.transparent = true;
    mm.opacity = alpha;
  };
  if (Array.isArray(mat)) mat.forEach(apply);
  else apply(mat);
}

/** Linear blend of two CSS hex colors (#rrggbb). t=0 → a, t=1 → b. Falls back
 *  to `a` if either isn't a parseable hex. */
function mixHex(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (!pa || !pb) return a;
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `#${[r, g, bl].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(c: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Build a Group of `layers` stacked Canvas2D-texture text planes faking a 3D
 * extrusion. Back layers sit at z=0 (deepest), the front face at z=depth, each
 * blended toward `sideColor` proportional to its depth so the stack reads as a
 * solid extruded slab. The returned Group's children are ordered back→front.
 */
export function buildFauxText(
  THREE: AnyTHREE,
  CanvasText: CanvasTextClass,
  opts: FauxOpts,
): import("three").Group {
  const group = new THREE.Group();
  const depth = opts.depth;
  const layers = opts.layers ?? Math.max(2, Math.min(12, Math.round(depth) + 2));
  const offsets = fauxLayerOffsets(depth, layers);
  // Default side color: a dark version of the front color (60% toward black).
  const side = opts.sideColor ?? mixHex(opts.color, "#000000", 0.6);

  const planes: import("three").Object3D[] = [];
  for (let i = 0; i < offsets.length; i++) {
    const isFront = i === offsets.length - 1;
    // Back layers blend fully toward `side`; the front face keeps `color`.
    const t = offsets.length > 1 ? 1 - i / (offsets.length - 1) : 0; // 1 at back, 0 at front
    const text = new CanvasText();
    text.text = opts.content;
    text.color = isFront ? opts.color : mixHex(opts.color, side, t);
    if (opts.font) text.font = opts.font;
    text.sync();
    text.position.z = offsets[i];
    // Anchor every layer on the font BASELINE, not its own texture center, so a
    // multi-glyph run shares one baseline (descenders g/j/p/y hang below it) —
    // matching the premium ExtrudeGeometry path. Without this, single-character
    // planes align by their centers. The run-level vertical centering happens
    // ONCE in build-text-three.ts (which measures the built geometry), so faux
    // must NOT re-center the block here.
    text.position.y = text.metrics.baselineOffset;
    const plane = text as unknown as import("three").Object3D;
    group.add(plane);
    planes.push(plane);
  }

  const frontPlane = planes[planes.length - 1];

  // Karaoke highlight: pre-rasterize a duplicate front plane in the highlight
  // color at build time, hidden. setColor toggles VISIBILITY between the base
  // front plane and this one — no per-frame Canvas2D re-raster.
  let highlightPlane: import("three").Object3D | null = null;
  if (opts.highlightColor) {
    const hp = new CanvasText();
    hp.text = opts.content;
    hp.color = opts.highlightColor;
    if (opts.font) hp.font = opts.font;
    hp.sync();
    // Sit just in front of the base front plane so it wins the depth test when shown.
    hp.position.z = frontPlane.position.z + Math.max(0.001, depth * 0.01);
    hp.position.y = hp.metrics.baselineOffset;
    hp.visible = false;
    const plane = hp as unknown as import("three").Object3D;
    group.add(plane);
    highlightPlane = plane;
  }

  // Per-glyph reveal hooks read by build-text-three's setColor/setOpacity closures.
  const userData = group.userData as {
    setColor?: (c: string | null) => void;
    setOpacity?: (a: number) => void;
  };
  userData.setColor = (c: string | null) => {
    if (!highlightPlane || !frontPlane) return; // no highlight built ⇒ scale-only
    const on = c != null;
    highlightPlane.visible = on;
    frontPlane.visible = !on;
  };
  userData.setOpacity = (a: number) => {
    for (const p of planes) setPlaneOpacity(p, a);
    if (highlightPlane) setPlaneOpacity(highlightPlane, a);
  };

  return group;
}
