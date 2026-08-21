// lib/runtime/installed-runtimes.ts
//
// Read `<LIBI_HOME>/runtime/` from the RUNTIME side — the mirror image of
// `electron/runtime-loader.ts#listUserRuntimePrefixes`, which does the same
// walk from the SHELL side.
//
// The duplication is deliberate and load-bearing: the loader is compiled into
// the shell bundle (`dist-electron/main.js`) and must not import runtime code,
// while this module runs inside the Next server. They agree on the on-disk
// LAYOUT — a versioned directory holding a `.libi-runtime.json` stamp — which
// is the actual contract, and that shape is asserted in the same test file.
//
// What this is used for: answering "you already downloaded 0.1.1; restart to
// finish updating" honestly across a page reload or a server restart. Deriving
// it from the disk rather than from in-memory install state means a user who
// clicked Install yesterday, quit, and reopened the app still sees the truth.
import fs from "node:fs";
import path from "node:path";

import {
  RUNTIME_PACKAGE,
  RUNTIME_STAMP_FILE,
  userRuntimeDir,
} from "@/lib/runtime/runtime-install";
import { compareVersions } from "@/lib/runtime/update-check";

export interface InstalledRuntimeEntry {
  prefix: string;
  version: string;
  shellApiVersion: number | null;
  abi: string | null;
  installedAt: string | null;
}

/**
 * Fetched runtimes on disk, newest first. Only stamped directories count —
 * `installRuntime` writes the stamp LAST, so an unstamped directory is a
 * half-finished or interrupted install and is not something to advertise.
 */
export function listInstalledRuntimes(rootDir?: string): InstalledRuntimeEntry[] {
  const root = rootDir ?? userRuntimeDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: InstalledRuntimeEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    try {
      const stamp = JSON.parse(
        fs.readFileSync(path.join(root, e.name, RUNTIME_STAMP_FILE), "utf-8"),
      ) as {
        package?: string;
        version?: string;
        shellApiVersion?: number;
        abi?: string;
        installedAt?: string;
      };
      if (stamp.package !== RUNTIME_PACKAGE || typeof stamp.version !== "string") {
        continue;
      }
      out.push({
        prefix: path.join(root, e.name),
        version: stamp.version,
        shellApiVersion: Number.isInteger(stamp.shellApiVersion)
          ? (stamp.shellApiVersion as number)
          : null,
        abi: typeof stamp.abi === "string" ? stamp.abi : null,
        installedAt: typeof stamp.installedAt === "string" ? stamp.installedAt : null,
      });
    } catch {
      // Missing / unparseable stamp — not a usable runtime. Skip silently;
      // the loader logs its own rejection reason at boot.
    }
  }
  out.sort((a, b) => compareVersions(b.version, a.version));
  return out;
}

/**
 * The version that will take over at next launch, or null.
 *
 * "Newer than what is running" is the honest test: a downloaded runtime older
 * than the current one changes nothing at next launch, so announcing it as
 * pending would be a lie.
 *
 * That rests on the loader selecting by version across EVERY candidate —
 * each staged prefix and the shell's bundled snapshot — which it does as of
 * the A0b fix (`electron/runtime-loader.ts`, `resolveRuntime`). It did not
 * before: staged prefixes were preferred wholesale over bundled, so a staged
 * runtime older than the one inside a freshly-updated `.app` still took over
 * at next launch and this comment was wrong in exactly that case.
 */
export function pendingRuntimeVersion(
  currentVersion: string | null,
  rootDir?: string,
): string | null {
  const installed = listInstalledRuntimes(rootDir);
  if (installed.length === 0) return null;
  const newest = installed[0].version;
  if (!currentVersion) return newest;
  return compareVersions(newest, currentVersion) > 0 ? newest : null;
}
