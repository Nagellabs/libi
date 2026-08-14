// lib/effects/builtin/zoom.ts
// Motion signature: scale eases from `from`(0.7) to 1 with opacity 0→1 (zoom in);
// Ken-Burns on scenes. Identity at p=1. Mirrors CapCut "Zoom / Push".
import type { EffectDef, TransformDelta } from "../types";

function easeOutCubic(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}

export const zoomEffect: EffectDef = {
  meta: {
    id: "zoom",
    name: "Zoom / Push",
    family: "animation",
    phases: ["in", "out"],
    supports: ["text", "image", "video", "code", "three", "tracked", "scene"],
    params: [
      { key: "from", label: "From scale", type: "number", min: 0.1, max: 1, step: 0.05, default: 0.7 },
    ],
    defaultDurationMs: 500,
  },
  animate: (p, params) => {
    if (p >= 1) return {};
    const from = (params.from as number) ?? 0.7;
    const e = easeOutCubic(p);
    const scale = from + (1 - from) * e;
    const d: TransformDelta = {};
    if (scale !== 1) d.scale = scale;
    if (p < 1) d.opacity = e;
    return d;
  },
};
