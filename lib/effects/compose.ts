// lib/effects/compose.ts
import type { EffectDef, LayerEffects, ResolvedParams, TransformDelta } from "./types";
import { inProgress, outProgress, loopPhase } from "./phase-timing";

/**
 * Effective params for an effect at render time: the effect def's declared
 * param DEFAULTS (from its manifest) with the applied ref's params layered on
 * top. Built-in effects default each param internally (`params.x ?? 12`), but a
 * custom effect's `animate.js` typically reads `params.x` directly — so an
 * applied ref with NO params (the common case: `apply_layer_effect` stores just
 * `{ effectId }`) would feed `undefined` and produce NaN deltas → no visible
 * animation. Merging the manifest defaults here makes every effect animate with
 * its declared defaults, matching what the inspector already shows.
 */
function resolveParams(
  def: EffectDef,
  refParams: Record<string, number | string> | undefined,
): ResolvedParams {
  const out: ResolvedParams = {};
  for (const p of def.meta.params) {
    if (p.default !== undefined) out[p.key] = p.default;
  }
  if (refParams) Object.assign(out, refParams);
  return out;
}

export interface ComposeInput {
  effects: LayerEffects | undefined;
  /** Composition-global time in seconds. */
  globalTime: number;
  /** Element window start (seconds) and duration (seconds). */
  startTime: number;
  duration: number;
}

type Resolver = (effectId: string) => EffectDef | undefined;

/** Accumulator: every SCALAR delta field is required (so fold/sparsify stay
 *  exhaustive), but the non-scalar `clipReveal` is optional — no effect folds it
 *  today, and there is no meaningful scalar accumulation for an edge/fraction. */
type DeltaAcc = Required<Omit<TransformDelta, "clipReveal">> & Pick<TransformDelta, "clipReveal">;

/** Tracks which fields have been touched by at least one effect slot. */
interface Touched {
  dx: boolean; dy: boolean; scale: boolean; scaleX: boolean; scaleY: boolean;
  rotateDeg: boolean; opacity: boolean; blurPx: boolean; clipReveal: boolean;
}

/** Fold one slot's delta into the accumulator (mutates `acc` and `touched`). */
function fold(acc: DeltaAcc, touched: Touched, d: TransformDelta): void {
  if (d.dx !== undefined)       { acc.dx += d.dx;            touched.dx = true; }
  if (d.dy !== undefined)       { acc.dy += d.dy;            touched.dy = true; }
  if (d.scale !== undefined)    { acc.scale *= d.scale;      touched.scale = true; }
  if (d.scaleX !== undefined)   { acc.scaleX *= d.scaleX;    touched.scaleX = true; }
  if (d.scaleY !== undefined)   { acc.scaleY *= d.scaleY;    touched.scaleY = true; }
  if (d.rotateDeg !== undefined){ acc.rotateDeg += d.rotateDeg; touched.rotateDeg = true; }
  if (d.opacity !== undefined)  { acc.opacity *= d.opacity;  touched.opacity = true; }
  if (d.blurPx !== undefined)   { acc.blurPx += d.blurPx;   touched.blurPx = true; }
  if (d.clipReveal !== undefined) { acc.clipReveal = d.clipReveal; touched.clipReveal = true; }
}

/** Collapse the accumulator back to a sparse delta. Only fields touched by at
 *  least one effect are emitted; untouched fields (true identity) are dropped so
 *  the renderer can cheaply detect a no-op. */
function sparsify(acc: DeltaAcc, touched: Touched): TransformDelta {
  const out: TransformDelta = {};
  if (touched.dx)        out.dx = acc.dx;
  if (touched.dy)        out.dy = acc.dy;
  if (touched.scale)     out.scale = acc.scale;
  if (touched.scaleX)    out.scaleX = acc.scaleX;
  if (touched.scaleY)    out.scaleY = acc.scaleY;
  if (touched.rotateDeg) out.rotateDeg = acc.rotateDeg;
  if (touched.opacity)   out.opacity = acc.opacity;
  if (touched.blurPx)    out.blurPx = acc.blurPx;
  if (touched.clipReveal) out.clipReveal = acc.clipReveal;
  return out;
}

/** Resolve all three slots at `globalTime` and compose into one delta. */
export function composeEffects(input: ComposeInput, resolve: Resolver): TransformDelta {
  const fx = input.effects;
  if (!fx) return {};
  const acc: DeltaAcc = {
    dx: 0, dy: 0, scale: 1, scaleX: 1, scaleY: 1, rotateDeg: 0, opacity: 1, blurPx: 0,
  };
  const touched: Touched = {
    dx: false, dy: false, scale: false, scaleX: false, scaleY: false,
    rotateDeg: false, opacity: false, blurPx: false, clipReveal: false,
  };
  if (fx.in) {
    const def = resolve(fx.in.effectId);
    if (def && !def.meta.textInternal && !def.meta.audioEnvelope) {
      const p = inProgress(input.globalTime, input.startTime, input.duration, fx.in.durationMs);
      fold(acc, touched, def.animate(p, resolveParams(def, fx.in.params)));
    }
  }
  if (fx.out) {
    const def = resolve(fx.out.effectId);
    if (def && !def.meta.textInternal && !def.meta.audioEnvelope) {
      // `outProgress` runs 0→1 toward the element end; effects are authored in
      // "in semantics" (p=1 = settled identity), so feed the REVERSE — the out
      // is the time-reverse of the in. animate(1)=home at out-start, animate(0)=
      // displaced at the element's end.
      const p = 1 - outProgress(input.globalTime, input.startTime, input.duration, fx.out.durationMs);
      fold(acc, touched, def.animate(p, resolveParams(def, fx.out.params)));
    }
  }
  if (fx.loop) {
    const def = resolve(fx.loop.effectId);
    if (def && !def.meta.textInternal && !def.meta.audioEnvelope) {
      // Loop period: the applied ref's durationMs, else the effect's declared
      // defaultDurationMs (so a `{ effectId }`-only ref loops at the intended
      // period, not the generic 1000ms fallback).
      const p = loopPhase(
        input.globalTime,
        input.startTime,
        fx.loop.durationMs ?? def.meta.defaultDurationMs,
      );
      fold(acc, touched, def.animate(p, resolveParams(def, fx.loop.params)));
    }
  }
  return sparsify(acc, touched);
}
