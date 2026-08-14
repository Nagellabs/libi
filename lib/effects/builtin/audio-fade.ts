// lib/effects/builtin/audio-fade.ts
// Motion signature: audioEnvelope effects — they don't touch the canvas; the
// `opacity` field carries the gain multiplier (0..1). in = 0→1, out = 1→0.
import type { EffectDef } from "../types";

export const audioFadeIn: EffectDef = {
  meta: {
    id: "audio-fade-in",
    name: "Audio fade-in",
    family: "animation",
    phases: ["in"],
    supports: ["audio"],
    params: [],
    audioEnvelope: true,
    defaultDurationMs: 600,
  },
  animate: (p) => ({ opacity: p }),
};

export const audioFadeOut: EffectDef = {
  meta: {
    id: "audio-fade-out",
    name: "Audio fade-out",
    family: "animation",
    phases: ["out"],
    supports: ["audio"],
    params: [],
    audioEnvelope: true,
    defaultDurationMs: 600,
  },
  animate: (p) => ({ opacity: 1 - p }),
};
