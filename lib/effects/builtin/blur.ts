// lib/effects/builtin/blur.ts
// Motion signature: blurPx falls from `radius`→0 (sharpens in) via easeOutQuad.
// Identity at p=1. Mirrors CapCut "Blur" in. Scene-capable.
import type { EffectDef, TransformDelta } from "../types";

function easeOutQuad(p: number): number { return 1 - (1 - p) * (1 - p); }

export const blurEffect: EffectDef = {
  meta: {
    id: "blur", name: "Blur", family: "animation",
    phases: ["in", "out"],
    supports: ["text", "image", "video", "code", "three", "tracked", "scene"],
    params: [{ key: "radius", label: "Radius", type: "number", min: 0, max: 40, step: 1, default: 12 }],
    defaultDurationMs: 500,
  },
  animate: (p, params) => {
    if (p >= 1) return {};
    const radius = (params.radius as number) ?? 12;
    const blur = radius * (1 - easeOutQuad(p));
    const d: TransformDelta = {};
    if (blur > 0.01) d.blurPx = blur;
    return d;
  },
};
