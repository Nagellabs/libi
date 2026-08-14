// lib/effects/builtin/float.ts
// Motion signature: loop — slow elliptical drift (dx,dy on offset sine phases),
// seamless. A gentle idle float. Mirrors CapCut "Drift / Float".
import type { EffectDef } from "../types";
export const floatEffect: EffectDef = {
  meta: {
    id: "float", name: "Float", family: "animation", phases: ["loop"],
    supports: ["text", "image", "video", "code", "three", "tracked"],
    params: [{ key: "amplitude", label: "Amplitude", type: "number", min: 0, max: 80, step: 2, default: 10 }],
    defaultDurationMs: 3000,
  },
  animate: (p, params) => {
    const a = (params.amplitude as number) ?? 10;
    return { dx: a * Math.sin(p * 2 * Math.PI), dy: a * 0.6 * Math.sin(p * 2 * Math.PI + Math.PI / 2) };
  },
};
