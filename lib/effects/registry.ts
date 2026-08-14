// lib/effects/registry.ts
import type { EffectDef, EffectPhase, LayerKind } from "./types";
import { BUILTIN_EFFECTS } from "./builtin";

/** Custom effects loaded from disk packages. REPLACED wholesale on each refresh
 *  (the loader passes the full current disk set) so removal works by re-loading. */
let CUSTOM: EffectDef[] = [];

/** Bumped on every registry mutation; lets React consumers subscribe via
 *  useSyncExternalStore (see hooks/preview/use-register-custom-effects.ts)
 *  instead of mirroring the registry into component state. */
let VERSION = 0;
const listeners = new Set<() => void>();

function notifyRegistryChanged(): void {
  VERSION++;
  for (const l of listeners) l();
}

/** Subscribe to registry mutations (useSyncExternalStore contract). */
export function subscribeEffectsRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Monotonic registry version (useSyncExternalStore snapshot). */
export function effectsRegistryVersion(): number {
  return VERSION;
}

/** Register the full current set of custom effects, replacing any prior set. */
export function registerCustomEffects(defs: EffectDef[]): void {
  CUSTOM = defs;
  notifyRegistryChanged();
}

/** Clear all custom effects (used by test teardown). */
export function clearCustomEffects(): void {
  CUSTOM = [];
  notifyRegistryChanged();
}

/** All registered effects: built-ins first, then customs. A custom id shadows
 *  a built-in of the same id (skills-style shadow semantics). */
function allEffects(): EffectDef[] {
  const m = new Map<string, EffectDef>();
  for (const e of BUILTIN_EFFECTS) m.set(e.meta.id, e);
  for (const e of CUSTOM) m.set(e.meta.id, e);
  return [...m.values()];
}

const byId = (): Map<string, EffectDef> => {
  const m = new Map<string, EffectDef>();
  for (const e of allEffects()) m.set(e.meta.id, e);
  return m;
};

export function findEffect(effectId: string): EffectDef | undefined {
  return byId().get(effectId);
}

export function isKnownEffectId(effectId: string): boolean {
  return byId().has(effectId);
}

export interface ListEffectsFilter {
  kind?: LayerKind;
  phase?: EffectPhase;
  family?: "animation";
}

export function listEffects(filter: ListEffectsFilter = {}): EffectDef[] {
  return allEffects().filter((e) => {
    if (filter.kind && !e.meta.supports.includes(filter.kind)) return false;
    if (filter.phase && !e.meta.phases.includes(filter.phase)) return false;
    if (filter.family && e.meta.family !== filter.family) return false;
    return true;
  });
}

/** Convenience resolver for composeEffects. */
export function resolveEffect(effectId: string): EffectDef | undefined {
  return findEffect(effectId);
}
