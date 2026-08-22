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
  SHELL_API_MAX_ENV,
  SHELL_API_MIN_ENV,
} from "@/lib/runtime/current-runtime";
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
 *
 * Deliberately UNFILTERED beyond the stamp check: this is the inventory, not
 * the verdict. Pruning (`lib/runtime/runtime-prune.ts`) exists precisely to
 * reclaim runtimes the loader will never select again, so a listing that
 * hid unloadable entries would strand exactly the directories B2a/B2b were
 * written to delete. Loadability is `pendingRuntimeVersion`'s question.
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

export interface PendingRuntimeOptions {
  /** Defaults to `process.env` — where the shell publishes its facts. */
  env?: Record<string, string | undefined>;
  /**
   * `process.versions.modules` of the process the loader runs in. Defaults to
   * THIS process's, which is correct in the only place the gate activates: a
   * packaged desktop app, where the Next server runs IN the Electron main
   * process (`electron/main.ts` → `lib/server/next-server.ts`, "IN THIS
   * PROCESS"). The install path already leans on that same identity —
   * `lib/jobs/runners/runtime-update.ts` stamps each staged runtime with this
   * process's `process.versions.modules` as the ABI the shell will check.
   * Override only in tests.
   */
  abi?: string;
}

function readIntEnv(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : null;
}

/**
 * Would the shell that published this env actually load `entry` at next
 * launch? Mirrors the loader's own gates 2–3 (`electron/runtime-loader.ts`,
 * `inspectRuntimePrefix`): ABI must match exactly, and `shellApiVersion` must
 * be an integer inside the shell's inclusive `[min, max]` range.
 *
 * When the shell has published no range — dev, `npx`, or a pre-0.1.4 shell —
 * this deliberately gates NOTHING and answers true. There is no loader whose
 * verdict we could be contradicting, and hiding a legitimately pending
 * runtime because two env vars were absent would be a worse lie than the one
 * this function exists to prevent.
 */
function shellWouldLoad(
  entry: InstalledRuntimeEntry,
  env: Record<string, string | undefined>,
  abi: string,
): boolean {
  const min = readIntEnv(env[SHELL_API_MIN_ENV]);
  const max = readIntEnv(env[SHELL_API_MAX_ENV]);
  if (min === null || max === null || min > max) return true;

  // From here down a shell HAS published its range, so the loader's refusals
  // are predictable — apply them, in its order.
  //
  // A stamp with no parseable `abi` or `shellApiVersion` is rejected by the
  // loader ("abi-mismatch" / "api-not-an-integer"), so it is not pending
  // either: counting it would re-open exactly the bug this gate closes.
  if (entry.abi === null || entry.abi !== abi) return false;
  if (entry.shellApiVersion === null) return false;
  return entry.shellApiVersion >= min && entry.shellApiVersion <= max;
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
 *
 * It equally rests on only counting candidates the loader would ACCEPT. The
 * loader also refuses on ABI and on the shell-API range, and a runtime staged
 * for a different shell generation fails those gates while winning the pure
 * version comparison — so it sat here as "pending", Settings promised a
 * restart would apply it, and the restart silently fell back (B2d). The
 * shell publishes its range into the env (`LIBI_SHELL_API_MIN/MAX`,
 * `electron/main.ts`); when present, candidates it would refuse are skipped
 * in favour of the newest one it would not.
 */
export function pendingRuntimeVersion(
  currentVersion: string | null,
  rootDir?: string,
  opts: PendingRuntimeOptions = {},
): string | null {
  const env = opts.env ?? process.env;
  const abi = opts.abi ?? process.versions.modules;
  const loadable = listInstalledRuntimes(rootDir).filter((entry) =>
    shellWouldLoad(entry, env, abi),
  );
  if (loadable.length === 0) return null;
  // Already sorted newest first; the newest LOADABLE candidate is the one the
  // loader would pick, even when a newer-but-refusable one sits above it.
  const newest = loadable[0].version;
  if (!currentVersion) return newest;
  return compareVersions(newest, currentVersion) > 0 ? newest : null;
}
