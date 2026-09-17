// lib/agents/adapter-tree.ts
//
// Everything that ANSWERS QUESTIONS about `~/.libi/agents` — where the tree
// is, which bins are in it, what the generated manifest says, how far it has
// drifted from the pin, whether some process is installing into it right now,
// and what to tell the user when an agent is unavailable.
//
// Split out of `runtime-install.ts`, which had grown to ~870 lines by
// holding both halves of the same subject. The seam is reads vs writes:
// NOTHING in this file changes the tree. `runtime-install.ts` keeps everything
// that does — the cross-process lock, `npm install`, the single-flight, the
// negative cache — and imports what it needs from here. That direction is the
// only one there is: this module knows nothing about installing.
//
// Every symbol below is re-exported from `runtime-install.ts` as well, so the
// move is invisible to callers and to its 1300-line test file. New code should
// import from here.
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { getLibiHome } from "@/lib/libi-home";
import { isWindows } from "@/lib/platform";
import {
  isLockStale,
  lockTimingForNpmTimeout,
  readInstalledVersion,
  type NpmInstallEntry,
} from "@/lib/install/npm-root";
import { adapterDownloadCopy } from "./adapter-copy";
import type { AgentUnavailableReason } from "./types";
import {
  CLAUDE_ADAPTER_PACKAGE,
  RUNTIME_AGENT_PACKAGES,
  type RuntimeAgentPackage,
} from "./runtime-packages";

/** The install lock's file name. Written by `runtime-install.ts`'s
 *  `acquireInstallLock` and only READ here. */
export const LOCK_FILE = ".agent-install.lock";

/**
 * 30 min. Much larger than the bundled-MCP root's 5 min. The adapter tree is
 * JS only (about 56 MB for Claude, 17 MB for Codex — downloaded with
 * `--omit=optional`, so no engine), but it is still many packages, and on a
 * slow or throttled connection it can outrun the small-package ceiling that
 * timeout was written for.
 *
 * The install lock's staleness/timeout are derived from this value (via
 * `lockTimingForNpmTimeout`, applied where `acquireInstallLock` is called
 * below) rather than hardcoded separately — raising this constant can never
 * again silently outrun the lock that's supposed to protect it. Exported so
 * tests can assert the two stay coupled.
 */
export const AGENT_NPM_INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

/** npm root for runtime agent packages — separate from the bundled-MCP root. */
export function getAgentInstallRoot(): string {
  return path.join(getLibiHome(), "agents");
}
/**
 * File names a `node_modules/.bin` entry can take, in preference order.
 *
 * On Windows npm's cmd-shim writes THREE files for one bin: an extensionless
 * `<name>` (a **bash** script, for Git Bash / MSYS), plus `<name>.cmd` and
 * `<name>.ps1`. `spawn()` without a shell can only run the `.cmd`; handing it
 * the extensionless bash script fails with ENOEXEC. Node also maps `X_OK` to
 * `F_OK` on Windows, so an executability check cannot tell them apart — the
 * extension has to. It is deliberately NOT a fallback here: resolving to
 * something that provably cannot spawn is worse than resolving to null, which
 * surfaces honestly as "Claude Code not installed".
 */
export function adapterBinFileNames(binName: string, platform: NodeJS.Platform): string[] {
  return platform === "win32" ? [`${binName}.cmd`, `${binName}.exe`] : [binName];
}

/**
 * First existing bin file for `binName` in `dir`, honouring Windows' `.cmd` /
 * `.exe` shim names. Exported because the codex adapter needs exactly this
 * check and was doing `execSync('test -x …')` instead — `test` is not a cmd
 * builtin, so on Windows that command always failed and codex was reported as
 * not installed on every machine.
 */
export function resolveBinIn(dir: string, binName: string): string | null {
  // `process.platform` inline as an ARGUMENT, deliberately not bound to a
  // local first: the bundler cannot fold through a parameter (adapterBinFileNames
  // compares its own `platform` arg safely), but it does fold through a
  // same-scope alias — see lib/platform.ts.
  for (const file of adapterBinFileNames(binName, process.platform)) {
    const candidate = path.join(dir, file);
    try {
      accessSync(candidate, isWindows() ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Absolute path to the runtime-installed adapter bin for `pkg`, or null. */
export function resolveInstalledAdapterBin(
  pkg: RuntimeAgentPackage = CLAUDE_ADAPTER_PACKAGE,
): string | null {
  return resolveBinIn(path.join(getAgentInstallRoot(), "node_modules", ".bin"), pkg.binName);
}

/**
 * Absolute path to `pkg`'s bin inside a developer checkout's own
 * `node_modules/`, or null. Both adapters are devDependencies, so `npm install`
 * puts them on disk in dev and the runtime install is skipped. Both are excluded
 * from the packaged Electron artifact and from the npm artifact (`npx libi`
 * never installs devDependencies), so in production this returns null and the
 * runtime install runs.
 */
export function resolveRepoLocalAdapterBin(
  repoRoot: string,
  pkg: RuntimeAgentPackage = CLAUDE_ADAPTER_PACKAGE,
): string | null {
  return resolveBinIn(path.join(repoRoot, "node_modules", ".bin"), pkg.binName);
}

/**
 * Pure resolution order, split out so it is testable without a filesystem:
 *   1. repo-local node_modules/.bin     — dev; keeps `npm run dev` offline-capable
 *   2. ~/.libi/agents/node_modules/.bin — packaged app, installed at first run
 *   3. null                             — caller surfaces an actionable error
 *
 * There is deliberately no `npx` fallback: in a packaged app that would be an
 * unpinned network fetch of an arbitrary version. Used by
 * `lib/agents/acp/agent-registry.ts` to resolve the spawn command for the
 * claude-code agent.
 */
export function resolveClaudeAdapterBin(bins: {
  repoLocal: string | null;
  installed: string | null;
}): string | null {
  return bins.repoLocal ?? bins.installed ?? null;
}

function installEntry(pkg: RuntimeAgentPackage, version: string = pkg.pinnedVersion): NpmInstallEntry {
  return { id: pkg.npmPackage, name: pkg.npmPackage, npmPackage: pkg.npmPackage, pinnedVersion: version };
}

/**
 * The entries an install for `pkg` is SCOPED to — what drift detection and
 * post-install verification judge. Exactly one: asking for Codex must never
 * download Claude, and a stale Claude must never fail a Codex install.
 */
export function agentInstallEntries(pkg: RuntimeAgentPackage): NpmInstallEntry[] {
  return [installEntry(pkg)];
}

/**
 * The manifest `writePackageJson` hands npm for an install of `pkg`: `pkg` at
 * its pin, plus every OTHER runtime adapter that is already on disk, pinned
 * at its CURRENTLY INSTALLED version.
 *
 * Verified against the vendored npm with the exact `npmInstallArgs` flags: a
 * bare `npm install --no-save` still reifies `node_modules` to the manifest
 * and REMOVES packages absent from it. A manifest listing only the requested
 * adapter would therefore delete the other adapter's whole tree on every
 * switch. Listing the other at the version it already has makes npm treat it
 * as satisfied — nothing to fetch, nothing to prune — while an adapter that
 * is NOT on disk is left out, so it is not downloaded on someone else's
 * behalf. Computed right before the write, under the install lock, so a tree
 * another process finished while we waited is counted.
 */
export function agentManifestEntries(root: string, pkg: RuntimeAgentPackage): NpmInstallEntry[] {
  const entries = agentInstallEntries(pkg);
  for (const other of RUNTIME_AGENT_PACKAGES) {
    if (other.npmPackage === pkg.npmPackage) continue;
    const installed = readInstalledVersion(root, other.npmPackage);
    if (installed !== null) entries.push(installEntry(other, installed));
  }
  return entries;
}

/** Entries whose on-disk version doesn't match the pin (missing counts). */
export function driftedEntries(root: string, entries: NpmInstallEntry[]): NpmInstallEntry[] {
  return entries.filter((e) => readInstalledVersion(root, e.npmPackage) !== e.pinnedVersion);
}

export function describeDrift(root: string, drifted: NpmInstallEntry[]): string {
  return drifted
    .map(
      (e) =>
        `${e.npmPackage}: expected ${e.pinnedVersion}, got ${
          readInstalledVersion(root, e.npmPackage) ?? "missing"
        }`,
    )
    .join("; ");
}

/**
 * Why `root` still needs an npm install of `pkg`, or null when it is current.
 *
 * Only version drift (a missing adapter counts). There is no engine to check:
 * the adapter is installed with `--omit=optional` and the chat runs the user's
 * own CLI, so the adapter's JS at the pin IS the complete install. Every entry
 * point into the install path re-derives this from disk, so a later boot
 * repairs what an interrupted one left behind.
 */
export function pendingInstallReason(root: string, pkg: RuntimeAgentPackage): string | null {
  const drifted = driftedEntries(root, agentInstallEntries(pkg));
  if (drifted.length > 0) return `version drift (${describeDrift(root, drifted)})`;
  return null;
}

/**
 * The CURRENCY half of "already installed": true when `pkg`'s on-disk version
 * matches its pin (the other half is a resolvable adapter bin).
 *
 * Without this check on the healthy fast path, a pin bump reached NOBODY who
 * already had libi: a complete tree at yesterday's version short-circuited
 * past the drift check inside `installAgentPackages` forever, so an adapter
 * bump meant to give every user the current Claude models only ever landed on
 * fresh installs.
 *
 * A tree with no readable adapter manifest counts as NOT current, deliberately:
 * `readInstalledVersion` returns null there, and a version that cannot be read
 * is a version that cannot be vouched for. Treating "unknown" as "current"
 * would restore exactly this bug for anyone whose manifest went missing, and
 * the cost of being wrong the other way is one reinstall.
 */
export function adapterVersionCurrent(root: string, pkg: RuntimeAgentPackage): boolean {
  return readInstalledVersion(root, pkg.npmPackage) === pkg.pinnedVersion;
}

/** Back-compat alias — Claude only. No production caller any more;
 *  kept for the Claude-specific cases in runtime-install.test.ts. */
export function claudeAdapterVersionCurrent(root: string = getAgentInstallRoot()): boolean {
  return adapterVersionCurrent(root, CLAUDE_ADAPTER_PACKAGE);
}

/**
 * Is an agent-package install running RIGHT NOW, in this or any other process?
 *
 * The in-memory `inflight` promise below cannot answer this for the surface
 * that needs it: the install may be running in ANOTHER libi process (a second
 * instance, or a manual `npm install` into the agent root), and the server
 * process that serves `/api/agent/providers` never holds that promise. The
 * cross-process install lock is the only honest signal, and it is the same one
 * `acquireInstallLock` writes — so "installing" here means exactly "some
 * process holds the agent-root install lock", never a guess.
 *
 * The lock is per ROOT, not per adapter — both adapters install into the same
 * root under the same lock — so this answers "is any adapter installing".
 *
 * Staleness is judged with the SAME derived timing the acquire path uses, so
 * a long-but-live download is never mislabelled as an abandoned lock.
 * Cost is one `existsSync` on the healthy (no lock) path.
 */
export function claudeAdapterInstallInProgress(root: string = getAgentInstallRoot()): boolean {
  const lockPath = path.join(root, LOCK_FILE);
  if (!existsSync(lockPath)) return false;
  return !isLockStale(lockPath, lockTimingForNpmTimeout(AGENT_NPM_INSTALL_TIMEOUT_MS).staleMs);
}

/**
 * Why `pkg`'s agent is unavailable, in the vocabulary the install path already
 * uses. Consumed by `lib/agents/acp/agent-registry.ts` so the agent selector
 * can render a DISABLED row with an explanation instead of dropping the entry.
 *
 * `binRoot` is the root of the tree the resolved adapter bin belongs to, or
 * null when no adapter bin resolved anywhere. It no longer changes the answer:
 * a present bin IS the install, so the reason is always derived from the
 * install lock and the agent root's manifest.
 *
 * Only called when the agent is already known to be unavailable, so the
 * filesystem probes here never run on the healthy path.
 */
export function adapterUnavailableReason(
  binRoot: string | null,
  pkg: RuntimeAgentPackage,
): AgentUnavailableReason {
  const agentRoot = getAgentInstallRoot();
  // The same words the setup wizard uses for this download — see adapter-copy.ts.
  const copy = adapterDownloadCopy(pkg.agentId);

  if (claudeAdapterInstallInProgress(agentRoot)) {
    return {
      // The lock is per root, so while it is held the honest answer for EITHER
      // agent is "installing".
      code: "installing",
      message: copy.unavailableDownloading,
    };
  }

  const pending = pendingInstallReason(agentRoot, pkg);
  // `writePackageJson` runs immediately before npm, so a manifest in the agent
  // root is proof an install was ATTEMPTED here — the one on-disk fact that
  // separates "it failed" from "it never ran". The manifest is shared, so it
  // is read for `pkg`'s own entry: a Claude install having run says nothing
  // about whether Codex was ever attempted.
  const attempted = manifestLists(agentRoot, pkg);
  return {
    code: attempted ? "install_failed" : "not_installed",
    message: attempted ? copy.unavailableFailed : copy.unavailableMissing,
    ...(pending ? { detail: pending } : {}),
  };
}

/** Does the generated manifest in `root` carry an entry for `pkg`? */
function manifestLists(root: string, pkg: RuntimeAgentPackage): boolean {
  const version = readManifestDependency(root, pkg.npmPackage);
  return version !== null;
}

function readManifestDependency(root: string, npmPackage: string): string | null {
  try {
    const raw = readFileSync(path.join(root, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { dependencies?: Record<string, unknown> };
    const version = parsed.dependencies?.[npmPackage];
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/** Back-compat alias — Claude only. */
export function claudeAdapterUnavailableReason(binRoot: string | null): AgentUnavailableReason {
  return adapterUnavailableReason(binRoot, CLAUDE_ADAPTER_PACKAGE);
}
