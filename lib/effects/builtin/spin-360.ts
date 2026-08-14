// lib/effects/builtin/spin-360.ts
// Motion signature: loop — continuous full rotation 0°→±360° across the period
// (visually seamless). Mirrors CapCut "Spin 360".
import type { EffectDef } from "../types";
export const spin360Effect: EffectDef = {
  meta: {
    id: "spin-360", name: "Spin 360", family: "animation", phases: ["loop"],
    supports: ["text", "image", "video", "code", "three", "tracked"],
    params: [{ key: "direction", label: "Direction", type: "enum", options: ["cw", "ccw"], default: "cw" }],
    defaultDurationMs: 2000,
  },
  animate: (p, params) => ({ rotateDeg: 360 * p * (((params.direction as string) ?? "cw") === "cw" ? 1 : -1) }),
};
