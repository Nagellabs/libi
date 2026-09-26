// lib/effects/custom-curves.ts
//
// The page's side of custom effects: curve-backed `EffectDef`s. A custom
// effect's `animate.js` NEVER runs here — not in the preview app, not on the
// /render export page. `animate(progress, params)` looks up the sampled table
// for (effect, source hash, resolved params) and interpolates it
// (lib/effects/curve.ts); on a miss it asks the effect sampler — a sandbox of
// its own (lib/sandbox/effect-sampler.ts) — and returns identity until the
// table arrives, when subscribers repaint.
//
// The export does not repaint: it calls `prepareCustomEffectCurves` before its
// first frame, which samples every custom-effect slot of the composition and
// fails the export, naming the effect, if one cannot be sampled.
import { curveKey, CURVE_SAMPLES, interpolateCurve } from "./curve";
import { resolveParams } from "./compose";
import type { EffectDef, EffectMeta, LayerEffects, ResolvedParams, TransformDelta } from "./types";

/** At most this many sampled tables are kept (≈ 82 KB each); the least
 *  recently used is dropped and re-sampled if it is needed again. */
export const MAX_CURVES = 256;

/** What the store needs from a sampler (lib/sandbox/effect-sampler.ts). */
export interface CurveSampler {
  sample(req: { effectId: string; source: string; sourceHash: string; params: ResolvedParams }): Promise<Float64Array>;
  destroy(): void;
}

interface Body {
  source: string;
  sourceHash: string;
}

class CurveStore {
  private readonly curves = new Map<string, Float64Array>();
  private readonly pending = new Map<string, Promise<Float64Array>>();
  private readonly failures = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private sampler: CurveSampler | null = null;
  private factory: (() => CurveSampler) | null = null;

  /** Where samples come from. Set by the preview (and by the export page);
   *  unset, every custom effect is identity. Replacing it drops the old one. */
  configure(factory: (() => CurveSampler) | null): void {
    this.sampler?.destroy();
    this.sampler = null;
    this.factory = factory;
    this.pending.clear();
    this.failures.clear();
  }

  private samplerNow(): CurveSampler | null {
    if (!this.sampler && this.factory) this.sampler = this.factory();
    return this.sampler;
  }

  /** The table for `key`, marking it most recently used. */
  private get(key: string): Float64Array | undefined {
    const c = this.curves.get(key);
    if (c) {
      this.curves.delete(key);
      this.curves.set(key, c);
    }
    return c;
  }

  private put(key: string, curve: Float64Array): void {
    this.curves.set(key, curve);
    while (this.curves.size > MAX_CURVES) this.curves.delete(this.curves.keys().next().value!);
  }

  /** Sample `key` unless it is held, in flight, or already failed. */
  request(effectId: string, body: Body, params: ResolvedParams): Promise<Float64Array> {
    const key = curveKey(effectId, body.sourceHash, params);
    const held = this.get(key);
    if (held) return Promise.resolve(held);
    const failed = this.failures.get(key);
    if (failed) return Promise.reject(new Error(failed));
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const sampler = this.samplerNow();
    if (!sampler) return Promise.reject(new Error(`custom effect "${effectId}" could not be sampled: no effect sandbox is available here`));
    const p = sampler.sample({ effectId, source: body.source, sourceHash: body.sourceHash, params: { ...params } }).then(
      (curve) => {
        if (this.pending.get(key) === p) {
          this.pending.delete(key);
          this.put(key, curve);
          this.notify();
        }
        return curve;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (this.pending.get(key) === p) {
          this.pending.delete(key);
          this.failures.set(key, message);
          this.notify();
        }
        throw new Error(message);
      },
    );
    this.pending.set(key, p);
    return p;
  }

  /** The delta at `progress`: interpolated when the table is held, identity
   *  (and a request) when it is not. Never runs effect code. */
  animate(effectId: string, body: Body, progress: number, params: ResolvedParams): TransformDelta {
    const curve = this.get(curveKey(effectId, body.sourceHash, params));
    if (curve) return interpolateCurve(curve, CURVE_SAMPLES, progress);
    this.request(effectId, body, params).catch(() => {});
    return {};
  }

  /** Why (effect, params) could not be sampled, if it could not. */
  failureOf(effectId: string, sourceHash: string, params: ResolvedParams): string | undefined {
    return this.failures.get(curveKey(effectId, sourceHash, params));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const l of Array.from(this.listeners)) l();
  }

  /** Tests only. */
  reset(): void {
    this.configure(null);
    this.curves.clear();
    this.listeners.clear();
  }
}

const STORE = new CurveStore();

/** Point the store at a sampler (the preview: on mount; the export page: before its first frame). */
export function configureEffectSampler(factory: (() => CurveSampler) | null): void {
  STORE.configure(factory);
}

/** A sampled table arrived (or failed): repaint. */
export function subscribeCustomEffectCurves(listener: () => void): () => void {
  return STORE.subscribe(listener);
}

/** Tests only. */
export function resetCustomEffectCurves(): void {
  STORE.reset();
}

/** The body behind each curve-backed def — what `prepareCustomEffectCurves` samples. */
const BODIES = new WeakMap<EffectDef, Body>();

/** A custom effect as the page's registry holds it: its meta, and an
 *  `animate` that reads sampled curves. */
export function curveBackedEffect(meta: EffectMeta, source: string, sourceHash: string): EffectDef {
  const body: Body = { source, sourceHash };
  const def: EffectDef = { meta, animate: (progress, params) => STORE.animate(meta.id, body, progress, params) };
  BODIES.set(def, body);
  return def;
}


/**
 * Sample every custom-effect slot `carriers` use, at the params each one
 * resolves to, and resolve once ALL are held — the export's gate before its
 * first frame. Rejects with the first failure, which names the effect.
 */
export async function prepareCustomEffectCurves(
  carriers: readonly object[],
  resolve: (effectId: string) => EffectDef | undefined,
): Promise<number> {
  const waits: Promise<Float64Array>[] = [];
  const seen = new Set<string>();
  for (const c of carriers) {
    const fx = (c as { effects?: LayerEffects }).effects;
    if (!fx) continue;
    for (const ref of [fx.in, fx.out, fx.loop]) {
      if (!ref) continue;
      const def = resolve(ref.effectId);
      const body = def ? BODIES.get(def) : undefined;
      if (!def || !body || def.meta.textInternal || def.meta.audioEnvelope) continue;
      const params = resolveParams(def, ref.params);
      const key = curveKey(def.meta.id, body.sourceHash, params);
      if (seen.has(key)) continue;
      seen.add(key);
      waits.push(STORE.request(def.meta.id, body, params));
    }
  }
  // Every table must be held while the frames render: past the store's cap an
  // early one could be dropped again before its frame is drawn.
  if (waits.length > MAX_CURVES) {
    throw new Error(`this piece uses ${waits.length} distinct custom-effect settings; an export can hold at most ${MAX_CURVES}`);
  }
  await Promise.all(waits);
  return waits.length;
}
