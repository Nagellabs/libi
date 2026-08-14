// lib/effects/builtin/sway.ts
// Motion signature: loop — gentle rotate oscillation ±angle°, seamless (pendulum).
// Mirrors CapCut "Sway / Rock".
import type { EffectDef } from "../types";
export const swayEffect: EffectDef = {
  meta: {
    id: "sway", name: "Sway", family: "animation", phases: ["loop"],
    supports: ["text", "image", "video", "code", "three", "tracked"],
    params: [{ key: "angle", label: "Angle", type: "number", min: 0, max: 45, step: 1, default: 6 }],
    defaultDurationMs: 2000,
  },
  animate: (p, params) => ({ rotateDeg: ((params.angle as number) ?? 6) * Math.sin(p * 2 * Math.PI) }),
};
