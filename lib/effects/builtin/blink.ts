// lib/effects/builtin/blink.ts
// Motion signature: loop — opacity dips between ~min and 1 (a blink), seamless.
// 0.5+0.5*cos(2πp) → 1 at p=0 and p=1, dips to 0 mid-period. Mirrors CapCut "Blink".
import type { EffectDef } from "../types";
export const blinkEffect: EffectDef = {
  meta: {
    id: "blink", name: "Blink", family: "animation", phases: ["loop"],
    supports: ["text", "image", "video", "code", "three", "tracked"],
    params: [{ key: "min", label: "Min opacity", type: "number", min: 0, max: 1, step: 0.05, default: 0.1 }],
    defaultDurationMs: 800,
  },
  animate: (p, params) => {
    const min = (params.min as number) ?? 0.1;
    const w = 0.5 + 0.5 * Math.cos(p * 2 * Math.PI);
    return { opacity: min + (1 - min) * w };
  },
};
