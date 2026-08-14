import fs from "node:fs";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { getLibiNodeModulesRoot } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";
import type { BundledMcpDef } from "@/mcp/registry/types";
import {
  acquireInstallLock,
  readInstalledVersion,
  runNpmInstall,
  writePackageJson,
} from "@/lib/install/npm-root";

/**
 * 5 min — covers worst-case cold install on slow networks. Every bundled MCP
 * is a small JS package; the big platform binaries live in the SEPARATE agent
 * install root (`lib/agents/runtime-install.ts`), which sets its own ceiling.
 */
const NPM_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

export interface BundledInstallProgress {
  phase: "checking" | "installing" | "verifying";
  /** Currently-active package id (null while checking). */
  current: string | null;
  /** When known, total bytes for the active item's download. Not always available. */
  bytesDownloaded?: number;
  bytesTotal?: number | null;
}

export type BundledInstallProgressCallback = (p: BundledInstallProgress) => void;

export interface BundledInstallPkgStatus {
  id: string;
  name: string;
  npmPackage: string;
  pinnedVersion: string;
  /** Version currently on disk, or null if not installed. */
  installedVersion: string | null;
  status: "ready" | "drift" | "missing" | "installing" | "failed";
  error?: string | null;
}

export interface BundledInstallSnapshot {
  status: "idle" | "checking" | "installing" | "ready" | "failed";
  pkgs: BundledInstallPkgStatus[];
  error?: string | null;
}

const state: { snapshot: BundledInstallSnapshot; promise: Promise<void> | null } = {
  snapshot: { status: "idle", pkgs: [] },
  promise: null,
};

export function getBundledInstallSnapshot(): BundledInstallSnapshot {
  return state.snapshot;
}

/**
 * Bundled MCPs that opt into managed installs (have `npmPackage` set).
 * Excludes core/http/uvx defs.
 *
 * After the tier-1/tier-2 split (May 2026), no tier-1 def carries
 * npmPackage/pinnedVersion — bundled MCPs are tier-2 and installed by
 * the agent on demand via the libi install tools. This filter is kept
 * for forward-compat in case a future tier-1 dep ships as an npm
 * package; today it returns [].
 */
export function getManagedBundledNpmMcps(): BundledMcpDef[] {
  return BUNDLED_MCP_SERVERS.filter(
    (def) =>
      !def.core &&
      def.npmPackage &&
      def.pinnedVersion &&
      (def.installFlow ?? "tier-1") === "tier-1",
  );
}

/**
 * Reconcile `~/.libi/node_modules/` with the bundled-MCP manifest.
 *
 * Hot path (every pinned package already installed at the right version):
 *   - reads each `node_modules/<pkg>/package.json#version`, compares,
 *   - returns in a few milliseconds with no npm spawn.
 *
 * Cold / drift path (missing, wrong version, or fresh ~/.libi):
 *   - writes `<root>/package.json` listing every pinned dep,
 *   - runs `npm install --no-audit --no-fund --no-save --prefix <root>`,
 *   - validates the install by re-reading each package.json.
 *
 * Idempotent — concurrent callers share the same promise.
 *
 * Never throws — failures are captured in the per-package snapshot and the
 * overall status flips to `failed`. Callers proceed; the local-bin-resolver
 * falls back to the def's `npx` command for any package that didn't install.
 */
export async function ensureBundledNpmMcps(
  onProgress?: BundledInstallProgressCallback,
): Promise<void> {
  if (state.promise) return state.promise;
  state.promise = (async () => {
    const managed = getManagedBundledNpmMcps();
    if (managed.length === 0) {
      state.snapshot = { status: "ready", pkgs: [] };
      return;
    }

    const root = getLibiNodeModulesRoot();

    onProgress?.({ phase: "checking", current: null });

    state.snapshot = {
      status: "checking",
      pkgs: managed.map((def) => ({
        id: def.id,
        name: def.name,
        npmPackage: def.npmPackage!,
        pinnedVersion: def.pinnedVersion!,
        installedVersion: readInstalledVersion(root, def.npmPackage!),
        status: "missing",
      })),
    };

    // Recompute drift after baseline.
    state.snapshot.pkgs = state.snapshot.pkgs.map((p) => ({
      ...p,
      status:
        p.installedVersion === p.pinnedVersion
          ? "ready"
          : p.installedVersion === null
            ? "missing"
            : "drift",
    }));

    const needsInstall = state.snapshot.pkgs.some((p) => p.status !== "ready");
    if (!needsInstall) {
      logger.info(
        {
          tag: "bundled-install",
          op: "skip_all_ready",
          count: managed.length,
        },
        `Bundled MCP installs already match manifest (${managed.length} pkgs)`,
      );
      onProgress?.({ phase: "verifying", current: null });
      state.snapshot = { status: "ready", pkgs: state.snapshot.pkgs };
      return;
    }

    state.snapshot = {
      status: "installing",
      pkgs: state.snapshot.pkgs.map((p) =>
        p.status === "ready" ? p : { ...p, status: "installing" },
      ),
    };

    let lockReleased: (() => void) | null = null;
    try {
      fs.mkdirSync(root, { recursive: true });
      lockReleased = await acquireInstallLock(root);

      // Re-check after acquiring the lock — another process may have
      // installed while we waited.
      const postLockPkgs: BundledInstallPkgStatus[] = managed.map((def) => {
        const installed = readInstalledVersion(root, def.npmPackage!);
        return {
          id: def.id,
          name: def.name,
          npmPackage: def.npmPackage!,
          pinnedVersion: def.pinnedVersion!,
          installedVersion: installed,
          status: installed === def.pinnedVersion ? "ready" : installed === null ? "missing" : "drift",
        };
      });
      if (postLockPkgs.every((p) => p.status === "ready")) {
        logger.info(
          { tag: "bundled-install", op: "skip_after_lock", count: managed.length },
          "Another process completed the install while we waited — skipping",
        );
        onProgress?.({ phase: "verifying", current: null });
        state.snapshot = { status: "ready", pkgs: postLockPkgs };
        return;
      }

      logger.info(
        {
          tag: "bundled-install",
          op: "install_start",
          root,
          pkgs: postLockPkgs.map((p) => ({
            id: p.id,
            pinned: p.pinnedVersion,
            installed: p.installedVersion,
            status: p.status,
          })),
        },
        `Installing bundled MCP packages into ${root}`,
      );
      for (const pkg of postLockPkgs.filter((p) => p.status !== "ready")) {
        onProgress?.({ phase: "installing", current: pkg.id });
      }

      writePackageJson(
        root,
        managed.map((def) => ({
          id: def.id,
          name: def.name,
          npmPackage: def.npmPackage!,
          pinnedVersion: def.pinnedVersion!,
        })),
        {
          name: "libi-bundled-mcps",
          description: "Auto-generated by lib/mcp/bundled-install.ts. Do not edit by hand.",
        },
      );
      await runNpmInstall(root, {
        timeoutMs: NPM_INSTALL_TIMEOUT_MS,
        logTag: "bundled-install",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { tag: "bundled-install", op: "install_failed", err: message },
        "Bundled MCP install failed",
      );
      state.snapshot = {
        status: "failed",
        error: message,
        pkgs: state.snapshot.pkgs.map((p) =>
          p.status === "installing" ? { ...p, status: "failed", error: message } : p,
        ),
      };
      return;
    } finally {
      lockReleased?.();
    }

    const finalPkgs: BundledInstallPkgStatus[] = managed.map((def) => {
      const installed = readInstalledVersion(root, def.npmPackage!);
      const match = installed === def.pinnedVersion;
      return {
        id: def.id,
        name: def.name,
        npmPackage: def.npmPackage!,
        pinnedVersion: def.pinnedVersion!,
        installedVersion: installed,
        status: match ? "ready" : "failed",
        error: match ? null : `expected ${def.pinnedVersion}, got ${installed ?? "missing"}`,
      };
    });

    const anyFailed = finalPkgs.some((p) => p.status === "failed");
    state.snapshot = {
      status: anyFailed ? "failed" : "ready",
      pkgs: finalPkgs,
      error: anyFailed ? "one or more bundled packages failed to install" : null,
    };
    logger.info(
      {
        tag: "bundled-install",
        op: "install_done",
        status: state.snapshot.status,
        pkgs: finalPkgs.map((p) => ({ id: p.id, status: p.status })),
      },
      `Bundled MCP install complete (${state.snapshot.status})`,
    );
    onProgress?.({ phase: "verifying", current: null });
  })().finally(() => {
    state.promise = null;
  });
  return state.promise;
}

/** Test-only escape hatch. */
export function __resetBundledInstallForTests(): void {
  state.snapshot = { status: "idle", pkgs: [] };
  state.promise = null;
}
