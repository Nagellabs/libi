// lib/effects/builtin/flash.ts
// Motion signature: opacity flickers (a few quick pulses) while ramping to full,
// settling to opacity 1 at p=1. Mirrors CapCut "Flash".
import type { EffectDef } from "../types";

export const flashEffect: EffectDef = {
  meta: {
    id: "flash", name: "Flash", family: "animation",
    phases: ["in", "out"],
    supports: ["text", "image", "video", "code", "three", "tracked"],
    params: [{ key: "pulses", label: "Pulses", type: "number", min: 1, max: 6, step: 1, default: 3 }],
    defaultDurationMs: 500,
  },
  animate: (p, params) => {
    if (p >= 1) return { opacity: 1 };
    const pulses = (params.pulses as number) ?? 3;
    const flicker = 0.5 + 0.5 * Math.abs(Math.sin(p * pulses * Math.PI));
    const op = p * 1 + (1 - p) * flicker;
    return { opacity: Math.min(1, op) };
  },
};
