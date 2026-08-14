// lib/effects/packages.ts
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getLibiHome } from "@/lib/libi-home";
import { compileCustomEffect } from "./compile-custom";
import {
  customEffectManifestSchema,
  type CustomEffectManifest,
} from "./package-types";
import { registerCustomEffects } from "./registry";
import type { EffectDef } from "./types";

/** Where custom effect packages live: `<libiHome>/effects`. */
export function customEffectsDir(): string {
  return join(getLibiHome(), "effects");
}

/**
 * Load every custom effect package under `root` (dir-injectable for tests).
 * Each package is a directory with a `manifest.json` + `animate.js`. Invalid
 * packages are skipped and collected into `errors` — this NEVER throws.
 */
export function loadCustomEffectsFromDisk(
  root = customEffectsDir(),
): { defs: EffectDef[]; errors: { id: string; error: string }[] } {
  const defs: EffectDef[] = [];
  const errors: { id: string; error: string }[] = [];
  if (!existsSync(root)) return { defs, errors };

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    try {
      const manifest = customEffectManifestSchema.parse(
        JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")),
      );
      const source = readFileSync(join(dir, "animate.js"), "utf8");
      const r = compileCustomEffect(manifest, source);
      if (r.ok) defs.push(r.def);
      else errors.push({ id: entry.name, error: r.error });
    } catch (e) {
      errors.push({ id: entry.name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { defs, errors };
}

/** One entry in the client payload: the validated manifest + its raw animate source. */
export interface CustomEffectPayloadEntry {
  meta: CustomEffectManifest;
  source: string;
}

/**
 * Build the client-facing payload — every custom package's manifest + `animate.js`
 * source, re-read fresh from disk. ONLY packages whose source compiles cleanly via
 * the client-safe `compileCustomEffect` are included, so the browser never receives
 * a poison source it would then fail to compile. NEVER throws.
 */
export function loadCustomEffectPayload(
  root = customEffectsDir(),
): { custom: CustomEffectPayloadEntry[] } {
  const custom: CustomEffectPayloadEntry[] = [];
  if (!existsSync(root)) return { custom };

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    try {
      const meta = customEffectManifestSchema.parse(
        JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")),
      );
      const source = readFileSync(join(dir, "animate.js"), "utf8");
      // Only ship sources the client will be able to compile.
      if (compileCustomEffect(meta, source).ok) custom.push({ meta, source });
    } catch {
      // Skip unreadable / invalid packages — never surface to the client.
    }
  }

  return { custom };
}

/** Read disk → register into the shared registry. Server-side. Returns errors for logging. */
export function refreshCustomEffects(): {
  count: number;
  errors: { id: string; error: string }[];
} {
  const { defs, errors } = loadCustomEffectsFromDisk();
  registerCustomEffects(defs);
  return { count: defs.length, errors };
}
