// lib/effects/install-from-git.ts
// SERVER-ONLY. Git install + filesystem management of custom effect packages.
import { execFile } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { serverLogger as logger } from "@/lib/logger";
import { compileCustomEffect } from "./compile-custom";
import {
  customEffectManifestSchema,
  type CustomEffectManifest,
} from "./package-types";
import { customEffectsDir, refreshCustomEffects } from "./packages";

const TAG = "effects-install";

export type InstallResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/** Slug pattern mirrors `customEffectManifestSchema.id` — the single guard
 *  against path traversal for every id-keyed write/delete below. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;

function isSlug(id: string): boolean {
  return SLUG_RE.test(id) && basename(id) === id;
}

/** Read + validate a package directory (manifest.json + animate.js) through
 *  the client-safe compiler. Returns the parsed manifest + source on success. */
function validatePackageDir(
  dir: string,
): { ok: true; manifest: CustomEffectManifest; source: string } | { ok: false; error: string } {
  const manifestPath = join(dir, "manifest.json");
  const sourcePath = join(dir, "animate.js");
  if (!existsSync(manifestPath)) return { ok: false, error: "missing manifest.json" };
  if (!existsSync(sourcePath)) return { ok: false, error: "missing animate.js" };

  let manifest: CustomEffectManifest;
  try {
    manifest = customEffectManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const source = readFileSync(sourcePath, "utf8");
  const compiled = compileCustomEffect(manifest, source);
  if (!compiled.ok) return { ok: false, error: compiled.error };
  return { ok: true, manifest, source };
}

/** Persist a validated package to `<customEffectsDir()>/<id>/` and refresh the
 *  registry. The id is re-checked here as the final traversal guard. */
function persistPackage(manifest: CustomEffectManifest, source: string): InstallResult {
  if (!isSlug(manifest.id)) return { ok: false, error: "invalid package id" };
  const dest = join(customEffectsDir(), manifest.id);
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dest, "animate.js"), source);
  refreshCustomEffects();
  return { ok: true, id: manifest.id };
}

/** Transports git must NEVER be handed. `git clone` treats a URL's scheme as a
 *  transport selector: `ext::sh -c "…"` and `fd::` run arbitrary commands (RCE),
 *  and `file://` is a local-filesystem SSRF. Only http(s) is a real remote fetch.
 *  `z.string().url()` accepts all of the above, so we gate the scheme here. */
export function isHttpGitTransport(url: string): boolean {
  let scheme: string;
  try {
    scheme = new URL(url).protocol; // includes trailing ":", e.g. "https:"
  } catch {
    return false;
  }
  return scheme === "https:" || scheme === "http:";
}

/** Injectable clone fn. Default = `git clone --depth 1 <url> <dir>`. */
export type CloneFn = (url: string, dir: string) => Promise<void>;

const defaultClone: CloneFn = (url, dir) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      ["clone", "--depth", "1", url, dir],
      {
        timeout: 60_000,
        // Pin the transport allowlist regardless of host git config, so a
        // user's global `protocol.ext.allow=always` can't re-enable the RCE.
        env: { ...process.env, GIT_ALLOW_PROTOCOL: "http:https" },
      },
      (err) => (err ? reject(err) : resolve()),
    );
  });

/**
 * Clone a git repo containing a custom effect package, validate it, and on
 * success persist it under `<customEffectsDir()>/<manifest.id>/`. On ANY
 * failure the temp clone dir is removed and a structured error is returned —
 * a poison package is NEVER persisted.
 */
export async function installEffectFromGit(params: {
  url: string;
  clone?: CloneFn;
}): Promise<InstallResult> {
  const clone = params.clone ?? defaultClone;
  // Reject non-http(s) schemes BEFORE any clone runs. `ext::sh -c "…"` / `fd::`
  // are git RCE vectors and `file://` is an SSRF — none are legitimate remotes.
  if (!isHttpGitTransport(params.url)) {
    logger.warn(
      { tag: TAG, op: "install_bad_transport", url: params.url },
      "rejected git effect install: non-http(s) transport",
    );
    return { ok: false, error: "url must use an http(s) transport" };
  }
  const tmp = mkdtempSync(join(tmpdir(), "libi-fx-clone-"));
  try {
    await clone(params.url, tmp);
    const validated = validatePackageDir(tmp);
    if (!validated.ok) {
      logger.warn({ tag: TAG, op: "install_invalid", url: params.url, error: validated.error }, "rejected git effect package");
      return { ok: false, error: validated.error };
    }
    const result = persistPackage(validated.manifest, validated.source);
    if (result.ok) {
      logger.info({ tag: TAG, op: "install_ok", url: params.url, id: result.id }, "installed git effect package");
    }
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.warn({ tag: TAG, op: "install_error", url: params.url, error }, "git effect install failed");
    return { ok: false, error };
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
}

/**
 * Write an agent-authored package (manifest + animate source) directly. The
 * manifest + source are validated through `compileCustomEffect` BEFORE any
 * write — a failing validation persists nothing.
 */
export async function addEffect(params: {
  manifest: CustomEffectManifest;
  source: string;
}): Promise<InstallResult> {
  const parsed = customEffectManifestSchema.safeParse(params.manifest);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  const compiled = compileCustomEffect(parsed.data, params.source);
  if (!compiled.ok) return { ok: false, error: compiled.error };
  return persistPackage(parsed.data, params.source);
}

/**
 * Patch an existing on-disk package's source and/or manifest fields. The
 * merged package is re-validated; the write happens only when valid, so a bad
 * patch leaves the prior package intact.
 */
export async function updateEffect(params: {
  id: string;
  source?: string;
  manifest?: Partial<CustomEffectManifest>;
}): Promise<InstallResult> {
  if (!isSlug(params.id)) return { ok: false, error: "invalid package id" };
  const dir = join(customEffectsDir(), params.id);
  if (!existsSync(dir)) return { ok: false, error: `no package "${params.id}"` };

  let existingManifest: unknown;
  let existingSource: string;
  try {
    existingManifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    existingSource = readFileSync(join(dir, "animate.js"), "utf8");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const mergedManifestRaw = { ...(existingManifest as object), ...(params.manifest ?? {}) };
  const parsed = customEffectManifestSchema.safeParse(mergedManifestRaw);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  // Disallow renaming the id out from under its directory.
  if (parsed.data.id !== params.id) return { ok: false, error: "cannot change package id" };

  const nextSource = params.source ?? existingSource;
  const compiled = compileCustomEffect(parsed.data, nextSource);
  if (!compiled.ok) return { ok: false, error: compiled.error };
  return persistPackage(parsed.data, nextSource);
}

/** Delete an on-disk package by id (slug-guarded) and refresh the registry. */
export async function removeEffect(params: { id: string }): Promise<InstallResult> {
  if (!isSlug(params.id)) return { ok: false, error: "invalid package id" };
  const dir = join(customEffectsDir(), params.id);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    logger.info({ tag: TAG, op: "remove_ok", id: params.id }, "removed effect package");
  }
  refreshCustomEffects();
  return { ok: true, id: params.id };
}

export interface EffectPackageInfo {
  id: string;
  name: string;
  valid: boolean;
  error?: string;
}

/** List on-disk packages with their validity (re-uses the disk loader's
 *  compile check so the reported state matches what gets registered). */
export async function listEffectPackages(): Promise<EffectPackageInfo[]> {
  const root = customEffectsDir();
  if (!existsSync(root)) return [];
  const out: EffectPackageInfo[] = [];
  // We want per-package validity INCLUDING invalid ones (so the UI can surface
  // them), so read directory entries directly rather than via the loader which
  // silently drops invalid packages.
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const validated = validatePackageDir(dir);
    if (validated.ok) {
      out.push({ id: entry.name, name: validated.manifest.name, valid: true });
    } else {
      out.push({ id: entry.name, name: entry.name, valid: false, error: validated.error });
    }
  }
  return out;
}
