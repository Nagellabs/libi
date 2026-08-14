import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { getLibiHome } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";
import {
  acquireInstallLock,
  isLockStale,
  lockTimingForNpmTimeout,
  readInstalledVersion,
  runNpmInstall,
  writePackageJson,
  type NpmInstallEntry,
} from "@/lib/install/npm-root";
import type { AgentUnavailableReason } from "./types";
import {
  claudeNativeBinaryMissingError,
  claudeNativeBinaryPresent,
} from "./claude-native-binary";
import { CLAUDE_ADAPTER_PACKAGE, RUNTIME_AGENT_PACKAGES } from "./runtime-packages";

/**
 * The Claude ACP adapter is installed at RUNTIME rather than bundled, because
 * it transitively pulls @anthropic-ai/claude-agent-sdk (+ its ~212MB platform
 * binary), which is "© Anthropic PBC. All rights reserved." — libi is GPL-3.0
 * and holds no licence to redistribute it. Installing it here means the user
 * obtains it from npm, Anthropic's own channel, under their own terms.
 *
 * Agent packages get their OWN npm root (`~/.libi/agents`), separate from the
 * bundled-MCP root (`~/.libi`). `npm install` is all-or-nothing per root: if
 * the adapter were in the bundled-MCP manifest, a single yanked/404 adapter
 * version would fail the whole install and mark EVERY bundled MCP as failed —
 * a Codex-only user would pay for a Claude-only outage. Separate roots also
 * keep each manifest self-contained, so neither prunes the other (both are
 * regenerated from scratch and installed with `--no-save`).
 *
 * Keep pinnedVersion in lockstep with package.json's devDependency on the
 * same package, so dev and production run identical adapter code. It is a
 * devDependency deliberately: `npm install` in a dev checkout still installs
 * it (so `resolveRepoLocalAdapterBin` below finds it and the dev skip
 * fires — no network, no behaviour change), but `npx libi` and the packaged
 * Electron artifact do NOT get it, which is the whole point of this file.
 */
export { CLAUDE_ADAPTER_PACKAGE };

const LOG_TAG = "agent-install";
const LOCK_FILE = ".agent-install.lock";

/**
 * 30 min. Much larger than the bundled-MCP root's 5 min: the adapter drags
 * @anthropic-ai/claude-agent-sdk's ~212MB platform binary behind it, which on
 * a slow or throttled connection comfortably exceeds the small-package
 * ceiling that timeout was written for.
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
  const platform = process.platform;
  for (const file of adapterBinFileNames(binName, platform)) {
    const candidate = path.join(dir, file);
    try {
      accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Absolute path to the runtime-installed adapter bin, or null if absent. */
export function resolveInstalledAdapterBin(): string | null {
  return resolveBinIn(
    path.join(getAgentInstallRoot(), "node_modules", ".bin"),
    CLAUDE_ADAPTER_PACKAGE.binName,
  );
}

/**
 * Absolute path to the adapter bin inside a developer checkout's own
 * `node_modules/`, or null. In dev the package is a devDependency, so `npm
 * install` still puts it on disk and the runtime install would be a
 * redundant ~212MB download into a cold `~/.libi`. It is excluded from both
 * the packaged Electron artifact (`electron-builder.yml`) and the npm
 * artifact (`npx libi` never installs devDependencies), so in production this
 * returns null and the runtime install runs.
 */
export function resolveRepoLocalAdapterBin(repoRoot: string): string | null {
  return resolveBinIn(
    path.join(repoRoot, "node_modules", ".bin"),
    CLAUDE_ADAPTER_PACKAGE.binName,
  );
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

export interface EnsureAdapterResult {
  installed: boolean;
  binPath: string | null;
  error?: string;
}

export interface EnsureAdapterOptions {
  /**
   * Checkout root to probe for an already-present adapter bin. Defaults to
   * `process.cwd()`; a parameter so tests can exercise both a dev checkout and
   * a packaged install without chdir-ing the process.
   */
  repoRoot?: string;
}

interface AgentInstallOutcome {
  ok: boolean;
  /** Real npm/verification diagnostic when `ok` is false — never swallowed. */
  error: string | null;
}

function agentInstallEntries(): NpmInstallEntry[] {
  return RUNTIME_AGENT_PACKAGES.map((pkg) => ({
    id: pkg.npmPackage,
    name: pkg.npmPackage,
    npmPackage: pkg.npmPackage,
    pinnedVersion: pkg.pinnedVersion,
  }));
}

/** Entries whose on-disk version doesn't match the pin (missing counts). */
function driftedEntries(root: string, entries: NpmInstallEntry[]): NpmInstallEntry[] {
  return entries.filter((e) => readInstalledVersion(root, e.npmPackage) !== e.pinnedVersion);
}

function describeDrift(root: string, drifted: NpmInstallEntry[]): string {
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
 * Why `root` still needs an npm install, or null when it is complete.
 *
 * Version drift is NOT sufficient on its own: the adapter is ~40KB of JS whose
 * ~212MB Claude binary rides in on an optionalDependency, and npm exits 0 when
 * an optional dependency fails. A tree can therefore match the manifest exactly
 * while being unusable. Checking the binary here — rather than only after an
 * install — is what makes a partial install self-healing instead of permanent:
 * every entry point into the install path re-derives "is this tree complete?"
 * from disk, so a later boot repairs what an interrupted one left behind.
 */
function pendingInstallReason(root: string, entries: NpmInstallEntry[]): string | null {
  const drifted = driftedEntries(root, entries);
  if (drifted.length > 0) return `version drift (${describeDrift(root, drifted)})`;
  if (!claudeNativeBinaryPresent(root)) return "native binary missing";
  return null;
}

/**
 * Is an agent-package install running RIGHT NOW, in this or any other process?
 *
 * The in-memory `inflight` promise below cannot answer this for the surface
 * that needs it: Category A runs `ensureClaudeAdapterInstalled()` in the CLI
 * process (`bin/libi.js`) BEFORE Next.js is spawned, so the server process
 * that serves `/api/agent/providers` never holds that promise. The
 * cross-process install lock is the only honest signal, and it is the same one
 * `acquireInstallLock` writes — so "installing" here means exactly "some
 * process holds the agent-root install lock", never a guess.
 *
 * Staleness is judged with the SAME derived timing the acquire path uses, so
 * a long-but-live 212MB download is never mislabelled as an abandoned lock.
 * Cost is one `existsSync` on the healthy (no lock) path.
 */
export function claudeAdapterInstallInProgress(root: string = getAgentInstallRoot()): boolean {
  const lockPath = path.join(root, LOCK_FILE);
  if (!existsSync(lockPath)) return false;
  return !isLockStale(lockPath, lockTimingForNpmTimeout(AGENT_NPM_INSTALL_TIMEOUT_MS).staleMs);
}

/**
 * Why Claude Code is unavailable, in the vocabulary the install path already
 * uses. Consumed by `lib/agents/acp/agent-registry.ts` so the agent selector
 * can render a DISABLED row with an explanation instead of dropping the entry.
 *
 * `binRoot` is the root of the tree the resolved adapter bin belongs to, or
 * null when no adapter bin resolved anywhere. A non-null `binRoot` here means
 * the adapter itself is present and only its native binary is missing — the
 * partial-install trap `claude-native-binary.ts` documents — so it reports
 * that directly rather than re-deriving version drift for a tree whose
 * adapter demonstrably matches.
 *
 * Only called when Claude Code is already known to be unavailable, so the
 * filesystem probes here never run on the healthy path.
 */
export function claudeAdapterUnavailableReason(
  binRoot: string | null,
  options: { agentRoot?: string } = {},
): AgentUnavailableReason {
  const agentRoot = options.agentRoot ?? getAgentInstallRoot();

  if (claudeAdapterInstallInProgress(agentRoot)) {
    return {
      code: "installing",
      message: "Installing Claude Code support (~212 MB) — this can take a few minutes.",
    };
  }

  if (binRoot !== null) {
    return {
      code: "install_failed",
      message: "Claude Code support is incomplete — restart libi to finish installing it.",
      detail: "native binary missing",
    };
  }

  const pending = pendingInstallReason(agentRoot, agentInstallEntries());
  // `writePackageJson` runs immediately before npm, so a manifest in the agent
  // root is proof an install was ATTEMPTED here — the one on-disk fact that
  // separates "it failed" from "it never ran".
  const attempted = existsSync(path.join(agentRoot, "package.json"));
  return {
    code: attempted ? "install_failed" : "not_installed",
    message: attempted
      ? "Claude Code support failed to install — restart libi to retry."
      : "Claude Code support isn't installed yet — restart libi to install it.",
    ...(pending ? { detail: pending } : {}),
  };
}

/**
 * Reconcile `~/.libi/agents/node_modules/` with the runtime-agent manifest.
 * Never throws — every failure is returned as a diagnostic string so callers
 * can report WHY (a blocked registry, a yanked version) instead of a bare
 * "not installed".
 */
async function installAgentPackages(root: string): Promise<AgentInstallOutcome> {
  const entries = agentInstallEntries();
  if (pendingInstallReason(root, entries) === null) {
    logger.info({ tag: LOG_TAG, op: "skip_all_ready", count: entries.length }, "Agent packages already match manifest");
    return { ok: true, error: null };
  }

  let releaseLock: (() => void) | null = null;
  try {
    mkdirSync(root, { recursive: true });
    releaseLock = await acquireInstallLock(root, {
      lockFile: LOCK_FILE,
      logTag: LOG_TAG,
      ...lockTimingForNpmTimeout(AGENT_NPM_INSTALL_TIMEOUT_MS),
    });

    // Re-check after the lock — another process may have installed while we waited.
    const reason = pendingInstallReason(root, entries);
    if (reason === null) {
      logger.info(
        { tag: LOG_TAG, op: "skip_after_lock", count: entries.length },
        "Another process installed the agent packages while we waited — skipping",
      );
      return { ok: true, error: null };
    }

    logger.info(
      {
        tag: LOG_TAG,
        op: "install_start",
        root,
        reason,
        pkgs: entries.map((e) => ({ npmPackage: e.npmPackage, pinned: e.pinnedVersion })),
      },
      `Installing runtime agent packages into ${root}`,
    );
    writePackageJson(root, entries, {
      name: "libi-runtime-agents",
      description: "Auto-generated by lib/agents/runtime-install.ts. Do not edit by hand.",
    });
    await runNpmInstall(root, { timeoutMs: AGENT_NPM_INSTALL_TIMEOUT_MS, logTag: LOG_TAG });
  } catch (err) {
    logger.warn(
      { tag: LOG_TAG, op: "install_failed", root, err },
      "Runtime agent package install failed — Codex and Terminal remain available",
    );
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    releaseLock?.();
  }

  const stillDrifted = driftedEntries(root, entries);
  if (stillDrifted.length > 0) {
    const error = describeDrift(root, stillDrifted);
    logger.warn(
      { tag: LOG_TAG, op: "install_verify_failed", root, error },
      "Runtime agent package install completed but verification failed",
    );
    return { ok: false, error };
  }

  // The adapter is present and correctly versioned — which says NOTHING about
  // the binary it must exec (see `pendingInstallReason`). Without this check a
  // half-downloaded tree reports success, the splash goes green, and the user
  // only discovers the truth at their first message.
  if (!claudeNativeBinaryPresent(root)) {
    const error = claudeNativeBinaryMissingError(root);
    logger.warn(
      { tag: LOG_TAG, op: "install_native_binary_missing", root, error },
      "Runtime agent package install completed but the Claude native binary is missing",
    );
    return { ok: false, error };
  }

  logger.info({ tag: LOG_TAG, op: "install_done", root }, "Runtime agent packages installed");
  return { ok: true, error: null };
}

let inflight: Promise<EnsureAdapterResult> | null = null;

/**
 * Negative cache for a failed install, scoped to this process's lifetime.
 *
 * Without this, `inflight` alone means every call after a failure re-runs a
 * full install attempt (up to the 30-min `AGENT_NPM_INSTALL_TIMEOUT_MS`
 * ceiling). The only current caller is the Category A boot phase — a single
 * call per process — but a boot-time call site on an offline/proxy-blocked
 * machine would otherwise turn a future second caller (e.g. a manual retry,
 * or a session-start path added later) into a multi-minute stall on every
 * attempt. Caching the failure for the process's lifetime (rather than a
 * short TTL) matches how every OTHER Category A failure is recovered today:
 * by restarting libi. There is no retry UI yet — when one is added, it can
 * exit the process (already the standard recovery) or explicitly clear this
 * cache before calling again.
 *
 * `resolveInstalledAdapterBin()` is still checked on every call BEFORE this
 * cache, so the cache never masks the adapter becoming available on disk
 * some other way (e.g. a different tool finishing the install).
 */
let cachedFailure: EnsureAdapterResult | null = null;

/**
 * Install the Claude ACP adapter into `~/.libi/agents/node_modules` if it
 * isn't already available.
 *
 * Order: a dev checkout's own `node_modules/.bin` wins FIRST — in the repo,
 * `node_modules/.bin/claude-agent-acp` must always win, so a developer whose
 * `~/.libi` was previously populated by a production run isn't silently
 * pinned to that installed copy instead of their checkout's; then an
 * existing agent-root bin whose native binary is also present (skip the
 * redundant download); then a cached failure from earlier this process (skip
 * the redundant re-attempt); otherwise install.
 *
 * The dev checkout's tree is deliberately NOT native-binary-verified: it is
 * owned by `npm install` in the repo, libi's runtime install cannot repair it
 * (the adapter resolves the SDK relative to its own location), and gating on
 * it would fail a CI checkout installed with `--omit=optional`.
 *
 * NEVER throws: a Claude install failure must not block boot — Codex and
 * Terminal must stay usable. On failure it returns the real npm/verification
 * diagnostic in `error`, so a user behind a registry-blocking proxy learns
 * why instead of getting a silent `installed: false`.
 */
export async function ensureClaudeAdapterInstalled(
  options: EnsureAdapterOptions = {},
): Promise<EnsureAdapterResult> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const repoLocal = resolveRepoLocalAdapterBin(repoRoot);
  if (repoLocal) {
    logger.info(
      { tag: LOG_TAG, op: "claude_adapter_dev_skip", binPath: repoLocal },
      "Claude adapter present in the local checkout — skipping the runtime install",
    );
    return { installed: true, binPath: repoLocal };
  }

  // An already-installed bin is only a fast path when the tree behind it is
  // COMPLETE. A bin whose native binary is missing must fall through to the
  // install (which repairs it) rather than short-circuit past it — otherwise
  // every subsequent boot re-blesses the same broken tree and only
  // `rm -rf ~/.libi/agents` ever recovers. The healthy path still costs one
  // `accessSync` for the bin plus a handful for the binary (~1ms), so this
  // does not reintroduce a per-boot reinstall.
  const agentRoot = getAgentInstallRoot();
  const existing = resolveInstalledAdapterBin();
  if (existing && claudeNativeBinaryPresent(agentRoot)) {
    return { installed: true, binPath: existing };
  }
  if (existing) {
    logger.warn(
      { tag: LOG_TAG, op: "claude_adapter_repair", root: agentRoot, binPath: existing },
      "Claude adapter is installed but its native binary is missing — reinstalling to repair",
    );
  }

  if (cachedFailure) {
    logger.info(
      { tag: LOG_TAG, op: "claude_adapter_negative_cache_hit", error: cachedFailure.error },
      "Skipping the Claude adapter install — it already failed earlier this run; restart libi to retry",
    );
    return cachedFailure;
  }

  if (inflight) return inflight;
  inflight = (async (): Promise<EnsureAdapterResult> => {
    const root = getAgentInstallRoot();
    const outcome = await installAgentPackages(root);

    const binPath = resolveInstalledAdapterBin();
    if (binPath && claudeNativeBinaryPresent(root)) {
      logger.info(
        { tag: LOG_TAG, op: "claude_adapter_installed", binPath },
        "Claude adapter installed",
      );
      return { installed: true, binPath };
    }

    const error =
      outcome.error ??
      (binPath
        ? `${CLAUDE_ADAPTER_PACKAGE.npmPackage}@${CLAUDE_ADAPTER_PACKAGE.pinnedVersion}: ${claudeNativeBinaryMissingError(root)}`
        : `${CLAUDE_ADAPTER_PACKAGE.npmPackage}@${CLAUDE_ADAPTER_PACKAGE.pinnedVersion}: install reported success but ${CLAUDE_ADAPTER_PACKAGE.binName} is missing from ${root}`);
    logger.warn(
      { tag: LOG_TAG, op: "claude_adapter_missing_after_install", root, error },
      "Claude adapter unavailable — Codex and Terminal remain available",
    );
    const result: EnsureAdapterResult = { installed: false, binPath: null, error };
    cachedFailure = result;
    return result;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}
