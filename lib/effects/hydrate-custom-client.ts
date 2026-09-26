// lib/effects/hydrate-custom-client.ts
import { customEffectManifestSchema, manifestToMeta, type CustomEffectManifest } from "./package-types";
import { curveBackedEffect } from "./custom-curves";
import { registerCustomEffects } from "./registry";
import type { EffectDef } from "./types";

/** One entry of the `GET /api/effects` payload. */
export interface CustomEffectPayloadEntry {
  meta: CustomEffectManifest;
  source: string;
  /** sha256 of `source` (lowercase hex), computed by the server — the curve key. */
  sourceHash: string;
}

const HASH = /^[0-9a-f]{64}$/;

/**
 * Turn a `/api/effects` payload's custom entries into curve-backed
 * `EffectDef`s (lib/effects/custom-curves.ts). NOTHING here compiles or runs
 * an `animate.js` body: the page registers the manifest's meta, and the body
 * only ever runs inside the effect sandbox, which answers with numbers. The
 * shared core of the preview hydration hook and the export render entry.
 * Skips an entry whose manifest or hash is malformed; never registers, never
 * throws.
 */
export function customEffectDefsFromPayload(
  entries: CustomEffectPayloadEntry[] | undefined,
): { defs: EffectDef[]; customIds: Set<string> } {
  const defs: EffectDef[] = [];
  const customIds = new Set<string>();
  for (const entry of entries ?? []) {
    const parsed = customEffectManifestSchema.safeParse(entry?.meta);
    if (!parsed.success || typeof entry.source !== "string" || typeof entry.sourceHash !== "string" || !HASH.test(entry.sourceHash)) continue;
    const def = curveBackedEffect(manifestToMeta(parsed.data), entry.source, entry.sourceHash);
    defs.push(def);
    customIds.add(def.meta.id);
  }
  return { defs, customIds };
}

/**
 * Fetch `/api/effects` and register its custom entries into the registry
 * instance THIS bundle reads — so `resolveEffect` finds them during render.
 * Used by the headless export `/render` entry (a standalone esbuild bundle
 * with its own module instances). A fetch/parse failure leaves built-ins
 * intact and resolves 0. Returns the number of custom effects registered.
 */
export async function hydrateCustomEffects(
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  try {
    const res = await fetchImpl("/api/effects");
    if (!res.ok) return 0;
    const data = (await res.json()) as { custom?: CustomEffectPayloadEntry[] };
    const { defs } = customEffectDefsFromPayload(data.custom);
    registerCustomEffects(defs);
    return defs.length;
  } catch {
    // Best-effort — the export still runs with built-in effects only.
    return 0;
  }
}
