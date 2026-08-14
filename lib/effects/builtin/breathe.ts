// lib/effects/builtin/breathe.ts
// Motion signature: loop — slow scale + opacity pulse ("breathing"), seamless.
// Mirrors CapCut "Breathe".
import type { EffectDef } from "../types";
export const breatheEffect: EffectDef = {
  meta: {
    id: "breathe", name: "Breathe", family: "animation", phases: ["loop"],
    supports: ["text", "image", "video", "code", "three", "tracked"],
    params: [{ key: "amount", label: "Amount", type: "number", min: 0, max: 0.5, step: 0.01, default: 0.06 }],
    defaultDurationMs: 3000,
  },
  animate: (p, params) => {
    const a = (params.amount as number) ?? 0.06;
    const s = 1 + a * Math.sin(p * 2 * Math.PI);
    const o = 1 - (a * 0.5) * (0.5 - 0.5 * Math.cos(p * 2 * Math.PI));
    return { scale: s, opacity: o };
  },
};
