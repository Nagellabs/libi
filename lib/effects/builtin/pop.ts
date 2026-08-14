// lib/effects/builtin/pop.ts
// Motion signature: scale springs 0→overshoot(~1.12)→settles to EXACTLY 1;
// opacity 0→1 over the first ~40%. Identity at p=1. Mirrors CapCut "Pop".
import type { EffectDef, TransformDelta } from "../types";

/** Spring that overshoots above 1 mid-window and settles to exactly 1 at p=1.
 *  Uses smoothstep + sin(p*π) so the overshoot is above 1 and the value is
 *  exactly 1 at p=1 (sin(π)=0). */
function springScale(p: number): number {
  if (p >= 1) return 1;
  const overshoot = 0.12;
  // smoothstep: 0 at p=0, 1 at p=1; sin(p*π): 0 at p=0, peaks at p=0.5, 0 at p=1
  const smoothstep = p * p * (3 - 2 * p);
  return smoothstep + overshoot * Math.sin(p * Math.PI);
}

export const popEffect: EffectDef = {
  meta: {
    id: "pop",
    name: "Pop",
    family: "animation",
    phases: ["in", "out"],
    supports: ["text", "image", "video", "code", "three", "tracked"],
    params: [],
    defaultDurationMs: 450,
  },
  animate: (p) => {
    if (p >= 1) return {};
    const d: TransformDelta = { scale: springScale(p) };
    const op = Math.min(1, p / 0.4);
    if (op < 1) d.opacity = op;
    return d;
  },
};
