// lib/effects/builtin/bounce.ts
// Motion signature: element enters offset by `distance` along an axis and settles
// to home (dy/dx → 0) at p=1 via a damped bounce (overshoots home a little, then
// resolves). Identity at p=1. Mirrors CapCut "Bounce".
import type { EffectDef, TransformDelta } from "../types";

function easeOutBounce(p: number): number {
  const n1 = 7.5625, d1 = 2.75;
  if (p < 1 / d1) return n1 * p * p;
  if (p < 2 / d1) { p -= 1.5 / d1; return n1 * p * p + 0.75; }
  if (p < 2.5 / d1) { p -= 2.25 / d1; return n1 * p * p + 0.9375; }
  p -= 2.625 / d1; return n1 * p * p + 0.984375;
}

export const bounceEffect: EffectDef = {
  meta: {
    id: "bounce", name: "Bounce", family: "animation",
    phases: ["in", "out"],
    supports: ["text", "image", "video", "code", "three", "tracked"],
    params: [
      { key: "direction", label: "Direction", type: "enum", options: ["up", "down", "left", "right"], default: "down" },
      { key: "distance", label: "Distance", type: "number", min: 0, max: 1000, step: 10, default: 200 },
    ],
    defaultDurationMs: 600,
  },
  animate: (p, params) => {
    if (p >= 1) return {};
    const dir = (params.direction as string) ?? "down";
    const dist = (params.distance as number) ?? 200;
    const off = dist * (1 - easeOutBounce(p));
    if (off === 0) return {};
    const d: TransformDelta = {};
    if (dir === "down") d.dy = -off;
    else if (dir === "up") d.dy = off;
    else if (dir === "left") d.dx = off;
    else d.dx = -off;
    return d;
  },
};
