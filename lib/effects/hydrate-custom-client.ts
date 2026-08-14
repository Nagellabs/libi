// lib/effects/hydrate-custom-client.ts
import { compileCustomEffect } from "./compile-custom";
import { registerCustomEffects } from "./registry";
import type { EffectDef } from "./types";
import type { CustomEffectManifest } from "./package-types";

/** One entry of the `GET /api/effects` payload. */
export interface CustomEffectPayloadEntry {
  meta: CustomEffectManifest;
  source: string;
}

/**
 * Compile a `/api/effects` payload's custom entries into runtime `EffectDef`s,
 * client-safe (no node:fs — uses the same sandbox compile as code overlays).
 * Skips any entry whose source fails to compile. Pure: never registers, never
 * throws — the shared core used by BOTH the preview hydration hook and the
 * export render entry.
 */
export function compileCustomPayload(
  entries: CustomEffectPayloadEntry[] | undefined,
): { defs: EffectDef[]; customIds: Set<string> } {
  const defs: EffectDef[] = [];
  const customIds = new Set<string>();
  for (const entry of entries ?? []) {
    const r = compileCustomEffect(entry.meta, entry.source);
    if (r.ok) {
      defs.push(r.def);
      customIds.add(r.def.meta.id);
    }
  }
  return { defs, customIds };
}

/**
 * Fetch `/api/effects`, compile its custom entries, and register them into the
 * registry instance THIS bundle reads — so `resolveEffect` finds them during
 * render. Used by the headless export `/render` entry (which is a standalone
 * esbuild bundle with its own module instances, separate from the preview app).
 * Best-effort: a fetch/parse failure leaves built-ins intact and resolves 0.
 * Returns the number of custom effects registered.
 */
export async function hydrateCustomEffects(
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  try {
    const res = await fetchImpl("/api/effects");
    if (!res.ok) return 0;
    const data = (await res.json()) as { custom?: CustomEffectPayloadEntry[] };
    const { defs } = compileCustomPayload(data.custom);
    registerCustomEffects(defs);
    return defs.length;
  } catch {
    // Best-effort — the export still runs with built-in effects only.
    return 0;
  }
}
