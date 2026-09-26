// lib/effects/compile-custom.ts
import {
  customEffectManifestSchema,
  manifestToMeta,
  type CustomEffectManifest,
} from "./package-types";
import { createAnimateFunction } from "@/lib/ai/scene-validator";
import { EFFECT_ANIMATE_HELPERS } from "./animate-helpers";
import type { EffectDef } from "./types";

export type CompileResult =
  | { ok: true; def: EffectDef }
  | { ok: false; error: string };

/** The server never animates a custom effect: its def is metadata only. */
const SERVER_IDENTITY: EffectDef["animate"] = () => ({});

/**
 * SERVER-SIDE validation of a custom effect package (manifest + `animate.js`):
 * the manifest schema, the static denylist and a syntax PARSE of the body.
 * The parsed function is discarded and never called — a custom effect body
 * runs only inside the effect sandbox's worker (lib/sandbox/effect-sampler.ts,
 * lib/sandbox/runtime/effect-curve.ts), which answers with numbers; the page
 * interpolates those (lib/effects/custom-curves.ts). So the def returned here
 * carries the effect's meta and an identity `animate`: the server registry is
 * read for metadata (find/list, the export classifier, the inspector's key
 * list), never to render.
 *
 * Returns `{ ok: false }` on manifest validation or a rejected / unparseable
 * body — NEVER throws, NEVER persists. Not imported by any page bundle
 * (`__tests__/unit/bundles/browser-bundle.test.ts`).
 */
export function compileCustomEffect(
  manifest: CustomEffectManifest,
  source: string,
): CompileResult {
  const parsed = customEffectManifestSchema.safeParse(manifest);
  if (!parsed.success) return { ok: false, error: parsed.error.message };

  try {
    // Parse only: `createAnimateFunction` validates and constructs; the
    // returned function is dropped here without being called.
    createAnimateFunction(source, EFFECT_ANIMATE_HELPERS);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  return { ok: true, def: { meta: manifestToMeta(parsed.data), animate: SERVER_IDENTITY } };
}
