// lib/effects/builtin/fade.ts
// Motion signature: opacity 0→1 linearly over the in-window (reverse for out).
// Pure opacity; no transform. Mirrors CapCut "Fade".
import type { EffectDef } from "../types";

export const fadeEffect: EffectDef = {
  meta: {
    id: "fade",
    name: "Fade",
    family: "animation",
    phases: ["in", "out"],
    supports: ["text", "image", "video", "code", "three", "tracked", "scene"],
    params: [],
    defaultDurationMs: 400,
  },
  animate: (p) => ({ opacity: p }),
};
