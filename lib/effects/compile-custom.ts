// lib/effects/compile-custom.ts
import {
  customEffectManifestSchema,
  manifestToMeta,
  type CustomEffectManifest,
} from "./package-types";
import { createAnimateFunction } from "@/lib/ai/scene-validator";
import { EFFECT_ANIMATE_HELPERS } from "./animate-helpers";
import type { EffectDef, ResolvedParams, TransformDelta } from "./types";

export type CompileResult =
  | { ok: true; def: EffectDef }
  | { ok: false; error: string };

/**
 * Compile a custom effect (validated manifest + sandboxed `animate.js` body)
 * into a runtime EffectDef. Returns `{ ok: false }` on manifest validation or
 * sandbox rejection — NEVER throws to the caller, NEVER persists.
 */
export function compileCustomEffect(
  manifest: CustomEffectManifest,
  source: string,
): CompileResult {
  const parsed = customEffectManifestSchema.safeParse(manifest);
  if (!parsed.success) return { ok: false, error: parsed.error.message };

  let animate: EffectDef["animate"];
  try {
    const fn = createAnimateFunction(source, EFFECT_ANIMATE_HELPERS);
    animate = (progress: number, params: ResolvedParams): TransformDelta =>
      fn(progress, params) as TransformDelta;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  return { ok: true, def: { meta: manifestToMeta(parsed.data), animate } };
}
