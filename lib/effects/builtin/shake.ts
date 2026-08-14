// lib/effects/builtin/shake.ts
// Motion signature: bounded pseudo-random jitter via summed sines (deterministic,
// seamless across the loop). dx/dy ∈ [-amount, amount]. Mirrors CapCut "Shake".
import type { EffectDef } from "../types";

// Sum of harmonics with integer frequencies → period-1 seamless; normalized to
// [-1,1] by dividing by the harmonic count.
function jitter(p: number, seed: number): number {
  const a = Math.sin(2 * Math.PI * (p + seed));
  const b = Math.sin(2 * Math.PI * (3 * p + seed * 2));
  const c = Math.sin(2 * Math.PI * (5 * p + seed * 3));
  return (a + b + c) / 3;
}

export const shakeEffect: EffectDef = {
  meta: {
    id: "shake",
    name: "Shake",
    family: "animation",
    phases: ["loop"],
    supports: ["text", "image", "video", "code", "three", "tracked", "scene"],
    params: [
      { key: "amount", label: "Amount", type: "number", min: 0, max: 50, step: 1, default: 8 },
    ],
    defaultDurationMs: 400,
  },
  animate: (p, params) => {
    const amount = (params.amount as number) ?? 8;
    const dx = amount * jitter(p, 0.13);
    const dy = amount * jitter(p, 0.71);
    const d: { dx?: number; dy?: number } = {};
    if (dx !== 0) d.dx = dx;
    if (dy !== 0) d.dy = dy;
    return d;
  },
};
