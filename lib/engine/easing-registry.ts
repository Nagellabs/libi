/**
 * Named-easing catalog + a CSS-style cubic-bézier solver.
 *
 * This is the single source of truth for keyframe easing curves. Each preset
 * gives BOTH a display bézier (for the future graph editor) and a runnable
 * easing function. Presets a cubic-bézier can't express (bounce, elastic)
 * carry a direct `fn`; the rest derive their `fn` from `bezier`.
 */

import {
  type EasingFunction,
  linear,
  easeInCubic,
  easeOutCubic,
  easeInOutCubic,
  easeInBack,
  easeOutBack,
  easeOutBounce,
  easeOutElastic,
} from "./animation";

export interface EasingPreset {
  /** Stable id, e.g. "ease-in-out". */
  id: string;
  /** Human label for the dropdown. */
  label: string;
  /** Display + fn source for bézier-representable presets. */
  bezier?: [number, number, number, number];
  /** Direct fn for presets a cubic-bézier can't express (bounce, elastic). */
  fn?: EasingFunction;
}

/** Ordered catalog for the easing dropdown. `ease-in-out` is the default. */
export const EASING_PRESETS: EasingPreset[] = [
  { id: "linear", label: "Linear", bezier: [0, 0, 1, 1] },
  { id: "ease-in", label: "Ease in", bezier: [0.42, 0, 1, 1] },
  { id: "ease-out", label: "Ease out", bezier: [0, 0, 0.58, 1] },
  { id: "ease-in-out", label: "Ease in-out", bezier: [0.42, 0, 0.58, 1] },
  { id: "ease-in-strong", label: "Ease in strong", fn: easeInCubic },
  { id: "ease-out-strong", label: "Ease out strong", fn: easeOutCubic },
  { id: "ease-in-out-strong", label: "Ease in-out strong", fn: easeInOutCubic },
  { id: "overshoot-in", label: "Overshoot in", fn: easeInBack },
  { id: "overshoot-out", label: "Overshoot out", fn: easeOutBack },
  { id: "bounce-out", label: "Bounce out", fn: easeOutBounce },
  { id: "elastic-out", label: "Elastic out", fn: easeOutElastic },
  // `custom` is a display-only placeholder: the real per-overlay curve arrives
  // as a `cubic-bezier(...)` literal via resolveEasing, not through this id.
  { id: "custom", label: "Custom", bezier: [0.42, 0, 0.58, 1] },
];

// cubic-bézier solver tuning (mirrors the shape browsers use to evaluate
// `cubic-bezier`): a few Newton steps, then a bisection safety net.
const NEWTON_ITERATIONS = 8;
const BISECTION_ITERATIONS = 30;
const SOLVE_EPSILON = 1e-6;

const PRESETS_BY_ID: Map<string, EasingPreset> = new Map(
  EASING_PRESETS.map((p) => [p.id, p]),
);

// ---------------------------------------------------------------------------
// cubicBezier
// ---------------------------------------------------------------------------

/**
 * Build a CSS-style `cubic-bezier(x1, y1, x2, y2)` easing function.
 *
 * The curve is a cubic Bézier from (0,0) to (1,1) with control points
 * (x1,y1) and (x2,y2). Given eased-time input `t ∈ [0,1]` (the x axis), we
 * solve for the Bézier parameter `s` where `X(s) = t` (Newton–Raphson with a
 * bisection fallback), then return `Y(s)`. Mirrors how browsers evaluate
 * `cubic-bezier`. Y-control points may lie outside [0,1] for overshoot.
 */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): EasingFunction {
  // Identity / linear fast-path.
  if (x1 === 0 && y1 === 0 && x2 === 1 && y2 === 1) {
    return linear;
  }

  // Bézier basis coefficients for a curve pinned at 0 and 1.
  // B(s) = 3(1-s)^2 s P1 + 3(1-s) s^2 P2 + s^3 (with P0 = 0, P3 = 1).
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;

  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const sampleDX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;

  const solveS = (t: number): number => {
    // Newton–Raphson from an initial guess of t.
    let s = t;
    for (let i = 0; i < NEWTON_ITERATIONS; i++) {
      const x = sampleX(s) - t;
      if (Math.abs(x) < SOLVE_EPSILON) return s;
      const dx = sampleDX(s);
      if (Math.abs(dx) < SOLVE_EPSILON) break;
      s -= x / dx;
    }

    // Bisection fallback. The returned wrapper only calls solveS for t in (0,1),
    // and X is monotonic there for our presets, so [lo,hi] always brackets a root.
    let lo = 0;
    let hi = 1;
    s = t;
    for (let i = 0; i < BISECTION_ITERATIONS; i++) {
      const x = sampleX(s);
      if (Math.abs(x - t) < SOLVE_EPSILON) return s;
      if (x < t) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return s;
  };

  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return sampleY(solveS(t));
  };
}

// ---------------------------------------------------------------------------
// resolveEasing
// ---------------------------------------------------------------------------

const CUBIC_BEZIER_RE = /^cubic-bezier\(\s*([^)]+)\s*\)$/i;

function easingForPreset(preset: EasingPreset): EasingFunction {
  if (preset.fn) return preset.fn;
  if (preset.bezier) return cubicBezier(...preset.bezier);
  return linear;
}

/**
 * Resolve an easing spec to a runnable function. Never throws.
 *
 * - `undefined` / unknown → `linear`
 * - a preset id → the preset's `fn`, else `cubicBezier(...preset.bezier)`
 * - a literal `"cubic-bezier(a,b,c,d)"` string → `cubicBezier(a,b,c,d)`
 * - anything malformed → `linear`
 */
export function resolveEasing(easing: string | undefined): EasingFunction {
  if (!easing) return linear;

  const preset = PRESETS_BY_ID.get(easing);
  if (preset) return easingForPreset(preset);

  const m = CUBIC_BEZIER_RE.exec(easing.trim());
  if (m) {
    const parts = m[1].split(",").map((s) => Number(s.trim()));
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      return cubicBezier(parts[0], parts[1], parts[2], parts[3]);
    }
  }

  return linear;
}
