/**
 * Sample a custom effect's `animate.js` — INSIDE the sandbox worker, the only
 * place a custom effect body ever runs (lib/effects/curve.ts for why and at
 * what resolution). The body is compiled here, with the pure-math helpers in
 * scope, and called `samples` times; the page receives only the numbers.
 *
 * A body that throws at some progress contributes identity there (the same
 * rule `createAnimateFunction` has always applied); one that returns anything
 * but numbers yields NaN, which the page reads as "absent". Each call gets a
 * fresh copy of `params`, so a body that mutates them cannot change the next
 * sample.
 *
 * This module runs inside the sandbox Worker: it must never touch `document`,
 * `window`, or anything server-side.
 */
import { createAnimateFunction } from "@/lib/ai/scene-validator";
import { EFFECT_ANIMATE_HELPERS } from "@/lib/effects/animate-helpers";
import { CURVE_FIELDS, encodeDelta } from "@/lib/effects/curve";
import { BodyError } from "./compile";

export function sampleEffectCurve(source: string, params: Record<string, number | string>, samples: number): Float64Array {
  let animate: ReturnType<typeof createAnimateFunction>;
  try {
    animate = createAnimateFunction(source, EFFECT_ANIMATE_HELPERS);
  } catch (err) {
    throw new BodyError("compile", err instanceof Error ? err.message : String(err));
  }
  const out = new Float64Array(CURVE_FIELDS.length * samples);
  for (let i = 0; i < samples; i++) {
    encodeDelta(animate(i / (samples - 1), { ...params }), out, i, samples);
  }
  return out;
}
