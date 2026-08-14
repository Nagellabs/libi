/**
 * Pure snap math for caption point-text editing.
 *
 * Two independent concerns:
 *  - Positional snapping along one axis to visual guides (frame center,
 *    rule-of-thirds, title-safe margins) and sibling overlay anchors.
 *  - Angular snapping to fixed detents (default 15°).
 *
 * No DOM, no React — just numbers in, numbers out.
 */

export interface SnapTarget {
  value: number;
  kind: "center" | "third" | "safe" | "overlay";
}

/**
 * Snap a 1-D position to the nearest target within `threshold`.
 * Returns the snapped value plus the caught target (or null when nothing is
 * in range). Ties resolve to the first target in array order.
 */
export function snapPosition1D(
  v: number,
  targets: SnapTarget[],
  threshold: number,
): { value: number; hit: SnapTarget | null } {
  let best: SnapTarget | null = null;
  let bestDist = Infinity;
  for (const t of targets) {
    const dist = Math.abs(t.value - v);
    if (dist <= threshold && dist < bestDist) {
      best = t;
      bestDist = dist;
    }
  }
  return best ? { value: best.value, hit: best } : { value: v, hit: null };
}

/**
 * Snap an angle (degrees) to `step`-degree detents (default 15).
 * `bypass=true` ⇒ identity. Otherwise rounds to the nearest multiple of step.
 * The result is NOT normalized to [0, 360).
 */
export function snapAngle(
  deg: number,
  opts?: { step?: number; bypass?: boolean },
): number {
  if (opts?.bypass) return deg;
  const step = opts?.step ?? 15;
  return Math.round(deg / step) * step;
}

function frameSnapTargets(
  frameSize: number,
  siblings: number[],
  safeInset: number,
): SnapTarget[] {
  const targets: SnapTarget[] = [
    { value: frameSize / 2, kind: "center" },
    { value: frameSize / 3, kind: "third" },
    { value: (frameSize * 2) / 3, kind: "third" },
    { value: frameSize * safeInset, kind: "safe" },
    { value: frameSize * (1 - safeInset), kind: "safe" },
  ];
  for (const s of siblings) {
    targets.push({ value: s, kind: "overlay" });
  }
  return targets;
}

/**
 * Positional snap targets for the X axis: frame center, rule-of-thirds (1/3,
 * 2/3), title-safe margins (default 5% inset), plus any sibling anchor X
 * positions.
 */
export function frameSnapTargetsX(
  frameW: number,
  siblings: number[],
  safeInset = 0.05,
): SnapTarget[] {
  return frameSnapTargets(frameW, siblings, safeInset);
}

/** Same as {@link frameSnapTargetsX} but for the Y axis. */
export function frameSnapTargetsY(
  frameH: number,
  siblings: number[],
  safeInset = 0.05,
): SnapTarget[] {
  return frameSnapTargets(frameH, siblings, safeInset);
}
