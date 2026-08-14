// lib/effects/builtin/wave.ts
// Motion signature: loop — vertical sine drift (seamless, dy(0)≡dy(1)). Whole-
// element variant (per-glyph text wave is deferred). Mirrors CapCut "Wave".
import type { EffectDef } from "../types";
export const waveEffect: EffectDef = {
  meta: {
    id: "wave", name: "Wave", family: "animation", phases: ["loop"],
    supports: ["text", "image", "video", "code", "three", "tracked"],
    params: [{ key: "amplitude", label: "Amplitude", type: "number", min: 0, max: 100, step: 2, default: 12 }],
    defaultDurationMs: 1200,
  },
  animate: (p, params) => ({ dy: ((params.amplitude as number) ?? 12) * Math.sin(p * 2 * Math.PI) }),
};
