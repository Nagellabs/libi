// lib/effects/builtin/spin.ts
// Motion signature: in/out — rotates from `turns`*360° into 0° (settled identity)
// via easeOutCubic. Mirrors CapCut "Rotate / Spin" entrance/exit. For LOOPING
// rotation use `spin-360` (continuous) or `sway` (oscillate) — a single
// transform-delta effect can't be both settling (in/out) and continuously
// looping, so spin is in/out only.
import type { EffectDef } from "../types";

function easeOutCubic(p: number): number { return 1 - Math.pow(1 - p, 3); }

export const spinEffect: EffectDef = {
  meta: {
    id: "spin", name: "Spin", family: "animation",
    phases: ["in", "out"],
    supports: ["text", "image", "video", "code", "three", "tracked"],
    params: [
      { key: "turns", label: "Turns", type: "number", min: 0.25, max: 4, step: 0.25, default: 1 },
    ],
    defaultDurationMs: 600,
  },
  animate: (p, params) => {
    if (p >= 1) return {};
    const turns = (params.turns as number) ?? 1;
    const rot = turns * 360 * (1 - easeOutCubic(p));
    if (rot === 0) return {};
    return { rotateDeg: rot };
  },
};
