// lib/effects/builtin/glitch.ts
// Motion signature: rapid DETERMINISTIC jitter (dx/dy) + opacity flicker — a digital
// "glitch". Jitter derived from sin() of progress (NEVER Math.random — must be
// deterministic for the 21-sample harness). Mirrors CapCut "Glitch".
import type { EffectDef, TransformDelta } from "../types";

export const glitchEffect: EffectDef = {
  meta: {
    id: "glitch", name: "Glitch", family: "animation",
    phases: ["loop", "in"],
    supports: ["text", "image", "video", "code", "three", "tracked"],
    params: [{ key: "intensity", label: "Intensity", type: "number", min: 0, max: 30, step: 1, default: 8 }],
    defaultDurationMs: 700,
  },
  animate: (p, params) => {
    const k = (params.intensity as number) ?? 8;
    const jx = Math.sin(p * 47 * Math.PI) * Math.sin(p * 13 * Math.PI);
    const jy = Math.sin(p * 53 * Math.PI + 1.3);
    const flick = 0.85 + 0.15 * Math.sin(p * 29 * Math.PI);
    const d: TransformDelta = { dx: k * jx, dy: k * 0.6 * jy, opacity: flick };
    return d;
  },
};
