// lib/effects/curve.ts
//
// A custom effect as NUMBERS. A custom effect's `animate.js` is agent- or
// package-written code, and it never runs in the studio's origin (not in the
// preview app, not on the /render export page): it runs only inside the
// overlay sandbox's opaque-origin worker (lib/sandbox/runtime/effect-curve.ts),
// which samples `animate(progress, params)` at CURVE_SAMPLES evenly spaced
// progresses and sends back this table. The page interpolates the table.
//
// Shared by the worker (encodeDelta) and the page (sanitizeCurve,
// interpolateCurve), so it must stay pure: no DOM, no server code.
//
// RESOLUTION — 1025 samples (1024 intervals over progress 0→1):
//  - A smooth curve's linear-interpolation error is at most (Δp)²/8 · max|f''|
//    with Δp = 1/1024 ≈ 0.001, i.e. ≈ 1.2e-7 · |f''|: an easeOutBack-style
//    500 px move (|f''| of a few thousand px per progress²) is off by well under
//    0.001 px — invisible, and far below the 1/255 opacity step.
//  - Frames per window: an in/out window of 17 s at 60 fps is 1020 frames, so
//    every realistic window is sampled at least once per frame; a long loop
//    period is still sub-pixel for smooth curves.
//  - A DISCONTINUITY (a step, a hard toggle) is smeared across one interval,
//    1/1024 of the window: at most one frame for any window up to ~17 s at
//    60 fps. Discrete outputs (clipReveal.edge, a field present on one side of
//    a step and absent on the other) take the NEAREST sample instead of a blend.
//  - Size: 10 fields × 1025 × 8 bytes ≈ 82 KB per (effect, source, params);
//    the page keeps at most MAX_CURVES of them (lib/effects/custom-curves.ts).
import type { TransformDelta } from "./types";

export const CURVE_SAMPLES = 1025;
/** The widest table the wire accepts (lib/sandbox/protocol.ts). */
export const MAX_CURVE_SAMPLES = 4097;

/** The table's columns, field-major: value of field f at sample i is
 *  `curve[f * samples + i]`. NaN means "absent at this sample" (identity). */
export const CURVE_FIELDS = ["dx", "dy", "scale", "scaleX", "scaleY", "rotateDeg", "opacity", "blurPx", "clipFraction", "clipEdge"] as const;
export type CurveField = (typeof CURVE_FIELDS)[number];
const F = Object.fromEntries(CURVE_FIELDS.map((f, i) => [f, i])) as Record<CurveField, number>;

const EDGES = ["left", "right", "top", "bottom"] as const;
type Edge = (typeof EDGES)[number];

/**
 * What a sampled value may be, per field — the page's bound on numbers that
 * came out of an untrusted realm (a body can return anything, and the worker
 * realm is the body's). Out of range is clamped; non-finite is dropped to
 * "absent", which is identity for that field.
 */
const RANGES: Record<Exclude<CurveField, "clipEdge">, [number, number]> = {
  dx: [-100_000, 100_000],
  dy: [-100_000, 100_000],
  scale: [-1_000, 1_000],
  scaleX: [-1_000, 1_000],
  scaleY: [-1_000, 1_000],
  rotateDeg: [-100_000, 100_000],
  opacity: [0, 1],
  blurPx: [0, 1_000],
  clipFraction: [0, 1],
};

/** Worker side: write one sample's delta into the table. Anything that is not
 *  a number for a numeric field — or not one of the four edges — is NaN. */
export function encodeDelta(delta: unknown, out: Float64Array, i: number, samples: number): void {
  const d = (delta !== null && typeof delta === "object" ? delta : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : Number.NaN);
  for (const f of ["dx", "dy", "scale", "scaleX", "scaleY", "rotateDeg", "opacity", "blurPx"] as const) {
    out[F[f] * samples + i] = num(d[f]);
  }
  const clip = d.clipReveal !== null && typeof d.clipReveal === "object" ? (d.clipReveal as Record<string, unknown>) : null;
  const edge = clip ? EDGES.indexOf(clip.edge as Edge) : -1;
  out[F.clipEdge * samples + i] = edge >= 0 ? edge + 1 : Number.NaN;
  out[F.clipFraction * samples + i] = edge >= 0 ? num(clip!.fraction) : Number.NaN;
}

/**
 * Page side: the ONLY way a sampled table is accepted. `buf` must be exactly
 * CURVE_FIELDS × `samples` float64s; every value is checked — non-finite → NaN
 * (absent), numeric fields clamped to RANGES, an edge that is not 1..4 → NaN.
 * Returns a fresh array (the transferred buffer is not kept), or null.
 */
export function sanitizeCurve(buf: unknown, samples: number): Float64Array | null {
  if (!(buf instanceof ArrayBuffer)) return null;
  if (!Number.isInteger(samples) || samples < 2 || samples > MAX_CURVE_SAMPLES) return null;
  if (buf.byteLength !== CURVE_FIELDS.length * samples * 8) return null;
  const src = new Float64Array(buf);
  const out = new Float64Array(src.length);
  for (let f = 0; f < CURVE_FIELDS.length; f++) {
    const name = CURVE_FIELDS[f]!;
    for (let i = 0; i < samples; i++) {
      const v = src[f * samples + i]!;
      let clean = Number.NaN;
      if (Number.isFinite(v)) {
        if (name === "clipEdge") clean = Number.isInteger(v) && v >= 1 && v <= 4 ? v : Number.NaN;
        else {
          const [lo, hi] = RANGES[name];
          clean = v < lo ? lo : v > hi ? hi : v;
        }
      }
      out[f * samples + i] = clean;
    }
  }
  return out;
}

/** Page side: the delta at `progress`, linearly interpolated between the two
 *  nearest samples; a field absent at either neighbour, and the clip edge,
 *  take the nearest sample. Never throws; never returns a non-finite number. */
export function interpolateCurve(curve: Float64Array, samples: number, progress: number): TransformDelta {
  const p = Number.isFinite(progress) ? (progress < 0 ? 0 : progress > 1 ? 1 : progress) : 0;
  const x = p * (samples - 1);
  const i0 = Math.floor(x);
  const i1 = i0 + 1 < samples ? i0 + 1 : i0;
  const t = x - i0;
  const near = t < 0.5 ? i0 : i1;
  const at = (f: number, i: number) => curve[f * samples + i]!;
  const value = (f: number): number | undefined => {
    const a = at(f, i0);
    const b = at(f, i1);
    if (Number.isFinite(a) && Number.isFinite(b)) return a + (b - a) * t;
    const n = at(f, near);
    return Number.isFinite(n) ? n : undefined;
  };
  const out: TransformDelta = {};
  for (const f of ["dx", "dy", "scale", "scaleX", "scaleY", "rotateDeg", "opacity", "blurPx"] as const) {
    const v = value(F[f]);
    if (v !== undefined) out[f] = v;
  }
  const edge = at(F.clipEdge, near);
  if (Number.isFinite(edge)) {
    const sameEdge = at(F.clipEdge, i0) === at(F.clipEdge, i1);
    const a = at(F.clipFraction, i0);
    const b = at(F.clipFraction, i1);
    const fraction = sameEdge && Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * t : at(F.clipFraction, near);
    if (Number.isFinite(fraction)) out.clipReveal = { edge: EDGES[edge - 1]!, fraction };
  }
  return out;
}

/** Deterministic text for a params object: keys sorted, values as-is. */
function stableParams(params: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]));
}

/** One sampled curve per (effect, exact source, resolved params). */
export function curveKey(effectId: string, sourceHash: string, params: Record<string, unknown>): string {
  return `${effectId}\u0000${sourceHash}\u0000${stableParams(params)}`;
}
