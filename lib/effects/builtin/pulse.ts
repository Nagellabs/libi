// lib/effects/builtin/pulse.ts
// Motion signature: scale = 1 + amount*sin(2πp), seamless across the loop
// (phase 0 and 1 both → scale 1). Mirrors CapCut loop "Pulse".
import type { EffectDef } from "../types";

export const pulseEffect: EffectDef = {
  meta: {
    id: "pulse",
    name: "Pulse",
    family: "animation",
    phases: ["loop"],
    supports: ["text", "image", "video", "code", "three", "tracked"],
    params: [
      { key: "amount", label: "Amount", type: "number", min: 0, max: 0.5, step: 0.01, default: 0.06 },
    ],
    defaultDurationMs: 1200,
  },
  animate: (p, params) => {
    const amount = (params.amount as number) ?? 0.06;
    const scale = 1 + amount * Math.sin(2 * Math.PI * p);
    return scale === 1 ? {} : { scale };
  },
};
