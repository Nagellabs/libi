// lib/effects/builtin/elastic.ts
// Motion signature: scaleX/scaleY spring with an elastic overshoot — stretches past
// size on one axis while squashing the other, oscillating with decay to EXACTLY
// 1×1 at p=1. Mirrors CapCut "Stretch / Elastic".
import type { EffectDef } from "../types";

function easeOutElastic(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const c4 = (2 * Math.PI) / 3;
  return Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * c4) + 1;
}

export const elasticEffect: EffectDef = {
  meta: {
    id: "elastic", name: "Elastic", family: "animation",
    phases: ["in", "out"],
    supports: ["text", "image", "video", "code", "three", "tracked"],
    params: [{ key: "amount", label: "Amount", type: "number", min: 0, max: 1, step: 0.05, default: 0.4 }],
    defaultDurationMs: 700,
  },
  animate: (p, params) => {
    if (p >= 1) return {};
    const amount = (params.amount as number) ?? 0.4;
    const e = easeOutElastic(p);
    const stretch = 1 + (e - 1) * amount;
    return { scaleX: stretch, scaleY: 2 - stretch };
  },
};
