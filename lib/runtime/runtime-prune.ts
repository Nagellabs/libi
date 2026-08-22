// lib/runtime/runtime-prune.ts
//
// Keep `<LIBI_HOME>/runtime/` from growing without bound, while GUARANTEEING
// that the version the user was running yesterday is still on disk.
//
// ## Why both halves matter
//
// A runtime snapshot is an npm install prefix with ~775 dependencies — on the
// order of a gigabyte. Fetching one per release and never deleting any would
// quietly eat a user's disk, and "libi ate 40 GB" is a support ticket nobody
// enjoys.
//
// But deleting eagerly is worse. The plan's Step 6 asks for rollback, and the
// cheapest honest form of it is simply *not deleting the previous version*:
// `electron/runtime-loader.ts` already picks the newest VALID prefix, so if a
// freshly-installed runtime turns out to be broken in a way the seven gates
// catch, the shell falls back to the previous one on its own, with no UI, no
// state, and no user action. That property only holds while the previous
// version still exists.
//
// So: keep the newest `keep` (default 2 — current + previous), plus never
// touch the prefix currently in use, and sweep the installer's own debris
// (`.tmp-*`, `.old-*`) which is dead by definition.
import fs from "node:fs";
import path from "node:path";

import { serverLogger as logger } from "@/lib/logger";
import { userRuntimeDir } from "@/lib/runtime/runtime-install";
import { compareVersions } from "@/lib/runtime/update-check";

const LOG_TAG = "runtime-update";

/** Current + previous. The minimum that makes fallback-on-next-launch real. */
export const DEFAULT_KEEP = 2;

export interface PruneOptions {
  /** How many version directories to retain, newest first. */
  keep?: number;
  /**
   * A prefix that must survive regardless of age — the one this process is
   * running from. Deleting the tree you are executing out of is a uniquely
   * bad way to save disk.
   */
  protectPrefix?: string | null;
  /** Defaults to `<LIBI_HOME>/runtime`. */
  rootDir?: string;
}

export interface PruneResult {
  removed: string[];
  kept: string[];
}

/**
 * Delete surplus fetched runtimes. Best-effort: a directory that refuses to
 * delete (a file held open, a permissions oddity) is logged and skipped — this
 * is housekeeping, and it must never fail the install that triggered it.
 */
export function pruneUserRuntimes(opts: PruneOptions = {}): PruneResult {
  const keep = Math.max(1, opts.keep ?? DEFAULT_KEEP);
  const root = opts.rootDir ?? userRuntimeDir();
  const protectedPrefix = opts.protectPrefix
    ? path.resolve(opts.protectPrefix)
    : null;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed: [], kept: [] };
  }

  const removed: string[] = [];
  const remove = (name: string, why: string): void => {
    const full = path.join(root, name);
    if (protectedPrefix && path.resolve(full) === protectedPrefix) return;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(full);
      logger.info({ tag: LOG_TAG, op: "prune_removed", dir: full, why }, "pruned runtime");
    } catch (err) {
      logger.warn(
        { tag: LOG_TAG, op: "prune_failed", dir: full, err: (err as Error).message },
        "could not prune runtime directory",
      );
    }
  };

  // Installer debris first — dead regardless of how many versions we keep.
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".tmp-") || e.name.includes(".old-")) {
      remove(e.name, "debris");
    }
  }

  const versions = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .filter((n) => !n.includes(".old-"))
    .sort((a, b) => compareVersions(b, a));

  const kept: string[] = [];
  let retained = 0;
  for (const name of versions) {
    const full = path.join(root, name);
    const isProtected =
      protectedPrefix !== null && path.resolve(full) === protectedPrefix;
    if (retained < keep || isProtected) {
      kept.push(full);
      retained += 1;
      continue;
    }
    remove(name, "surplus");
  }
  return { removed, kept };
}

/**
 * Delete staged runtimes the loader can never choose again.
 *
 * Since the A0b fix (`electron/runtime-loader.ts`), selection is by VERSION
 * across every candidate — each staged prefix and the bundled snapshot alike.
 * So once a shell update raises the bundled version, any staged runtime at or
 * below it is unreachable by definition: bundled outranks it on version, and
 * wins the tie too. It is pure disk cost, and a runtime is ~1.3 GB.
 *
 * `pruneUserRuntimes`' keep-2 rule cannot catch these. Its job is ROLLBACK —
 * keep the previous version so a broken new one falls back — and it counts
 * versions, so a user with exactly one stale staged runtime keeps it forever.
 * That is the observed case: 0.1.1 staged, shell updated to 0.1.3, 1.3 GB
 * stranded.
 *
 * Rollback is not weakened by this. Anything NEWER than bundled is left alone,
 * and bundled itself is always present and integrity-checked at build time —
 * it IS the floor to fall back to.
 *
 * A null/unparseable `bundledVersion` prunes NOTHING. An older shell does not
 * publish it, and "unknown" must never be read as "everything is stale".
 */
export function pruneRuntimesBelowBundled(opts: {
  bundledVersion: string | null;
  protectPrefix?: string | null;
  rootDir?: string;
}): PruneResult {
  const { bundledVersion } = opts;
  if (!bundledVersion) return { removed: [], kept: [] };

  const root = opts.rootDir ?? userRuntimeDir();
  const protectedPrefix = opts.protectPrefix ? path.resolve(opts.protectPrefix) : null;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed: [], kept: [] };
  }

  const removed: string[] = [];
  const kept: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name.includes(".old-")) continue;
    const full = path.join(root, e.name);
    // Never the running one. Deleting the tree you are executing out of is a
    // uniquely bad way to save disk — and a staged runtime CAN be running
    // when it is newer than bundled, which is exactly when we keep it anyway.
    if (protectedPrefix && path.resolve(full) === protectedPrefix) {
      kept.push(full);
      continue;
    }
    if (compareVersions(e.name, bundledVersion) > 0) {
      kept.push(full); // newer than bundled — still selectable, still a rollback target
      continue;
    }
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(full);
      logger.info(
        { tag: LOG_TAG, op: "prune_below_bundled", dir: full, bundledVersion },
        "pruned a staged runtime the loader can never select again",
      );
    } catch (err) {
      logger.warn(
        { tag: LOG_TAG, op: "prune_failed", dir: full, err: (err as Error).message },
        "could not prune runtime directory",
      );
    }
  }
  return { removed, kept };
}

/**
 * The prefix this process is running out of, or null.
 *
 * The runtime root is `<prefix>/node_modules/@nagellabs/libi` and
 * `electron/main.ts` chdirs to it, so three levels up is the prefix. Returns
 * null when the layout doesn't match (dev checkout, `npx` install), which is
 * exactly when there is nothing to protect.
 */
export function runningRuntimePrefix(cwd: string = process.cwd()): string | null {
  const parts = path.resolve(cwd).split(path.sep);
  if (parts.length < 4) return null;
  const [scope, name] = [parts[parts.length - 2], parts[parts.length - 1]];
  if (parts[parts.length - 3] !== "node_modules") return null;
  if (`${scope}/${name}` !== "@nagellabs/libi") return null;
  return parts.slice(0, parts.length - 3).join(path.sep);
}
