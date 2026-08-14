// lib/effects/builtin/slide.ts
// Motion signature: element enters from an offscreen direction; translation eases
// to 0 (home) by p=1 via easeOutCubic. Out reverses. Mirrors CapCut "Slide".
import type { EffectDef, TransformDelta } from "../types";

function easeOutCubic(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}

export const slideEffect: EffectDef = {
  meta: {
    id: "slide",
    name: "Slide",
    family: "animation",
    phases: ["in", "out"],
    supports: ["text", "image", "video", "code", "three", "tracked", "scene"],
    params: [
      { key: "direction", label: "Direction", type: "enum", options: ["left", "right", "up", "down"], default: "left" },
      { key: "distance", label: "Distance", type: "number", min: 0, max: 2000, step: 10, default: 300 },
    ],
    defaultDurationMs: 500,
  },
  animate: (p, params) => {
    const dir = (params.direction as string) ?? "left";
    const dist = (params.distance as number) ?? 300;
    // offset = distance at p=0, 0 at p=1
    const off = dist * (1 - easeOutCubic(p));
    const d: TransformDelta = {};
    if (off === 0) return d;
    if (dir === "left") d.dx = -off;
    else if (dir === "right") d.dx = off;
    else if (dir === "up") d.dy = -off;
    else d.dy = off; // down
    return d;
  },
};
