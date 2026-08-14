// lib/effects/builtin/wipe.ts
// Motion signature: in/out — revealed by a clip band growing from an edge
// (fraction 0→1) via easeInOutQuad. Fully revealed (no clip) at p=1. Requires the
// clipReveal delta field + compose propagation + renderer support. Mirrors CapCut "Wipe / Mask".
import type { EffectDef } from "../types";

function easeInOutQuad(p: number): number { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }

export const wipeEffect: EffectDef = {
  meta: {
    id: "wipe", name: "Wipe", family: "animation",
    phases: ["in", "out"],
    supports: ["text", "image", "video", "code", "three", "tracked"],
    params: [{ key: "edge", label: "Edge", type: "enum", options: ["left", "right", "top", "bottom"], default: "left" }],
    defaultDurationMs: 500,
  },
  animate: (p, params) => {
    const edge = ((params.edge as string) ?? "left") as "left" | "right" | "top" | "bottom";
    if (p >= 1) return {};
    return { clipReveal: { edge, fraction: easeInOutQuad(p) } };
  },
};
