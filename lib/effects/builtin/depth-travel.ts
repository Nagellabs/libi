// lib/effects/builtin/depth-travel.ts
// Motion signature: element travels along depth. forward = back→front: scale
// grows from `farScale`(0.4) to 1, blur falls from `farBlur`(6px) to 0, opacity
// rises. backward = front→back (reverse). Identity at the front. As loop it
// oscillates depth. The defining property: scale up ⇔ blur down toward front.
import type { EffectDef, TransformDelta } from "../types";

function easeInOut(p: number): number {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}

export const depthTravelEffect: EffectDef = {
  meta: {
    id: "depth-travel",
    name: "Depth travel",
    family: "animation",
    phases: ["in", "out", "loop"],
    supports: ["text", "image", "video", "code", "three", "tracked", "scene"],
    params: [
      { key: "direction", label: "Direction", type: "enum", options: ["forward", "backward"], default: "forward" },
      { key: "farScale", label: "Far scale", type: "number", min: 0.1, max: 1, step: 0.05, default: 0.4 },
      { key: "farBlur", label: "Far blur", type: "number", min: 0, max: 20, step: 1, default: 6 },
    ],
    defaultDurationMs: 700,
  },
  animate: (p, params) => {
    const dir = (params.direction as string) ?? "forward";
    const farScale = (params.farScale as number) ?? 0.4;
    const farBlur = (params.farBlur as number) ?? 6;
    // depth fraction: 1 = at front (sharp, full size), 0 = far (small, blurred)
    const front = dir === "forward" ? easeInOut(p) : easeInOut(1 - p);
    if (front >= 1) return {}; // at the front: identity
    const scale = farScale + (1 - farScale) * front;
    const blur = farBlur * (1 - front);
    const d: TransformDelta = {};
    if (scale !== 1) d.scale = scale;
    if (blur !== 0) d.blurPx = blur;
    const op = 0.3 + 0.7 * front;
    if (op < 1) d.opacity = op;
    return d;
  },
};
