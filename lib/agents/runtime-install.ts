/**
 * Both ACP adapters are installed at RUNTIME rather than bundled — and only
 * their JavaScript. The chat runs the user's own CLI, so the engine each
 * adapter lists as an optionalDependency (Claude's platform binary, Codex's
 * Rust binary) is never downloaded: npm runs with `--omit=optional`, and the
 * engines an older libi already downloaded are deleted at boot
 * (`./engine-cleanup`).
 *
 * The Claude adapter stays out of the bundle because it transitively pulls
 * @anthropic-ai/claude-agent-sdk, which is "© Anthropic PBC. All rights
 * reserved." — libi is GPL-3.0 and holds no licence to redistribute it.
 * Installing it here means the user obtains it from npm, Anthropic's own
 * channel, under their own terms. The Codex adapter for SIZE: it was carried
 * by every install whether or not the user ever chose Codex (see
 * `runtime-packages.ts`).
 *
 * Agent packages get their OWN npm root (`~/.libi/agents`), separate from the
 * bundled-MCP root (`~/.libi`). `npm install` is all-or-nothing per root: if
 * the adapter were in the bundled-MCP manifest, a single yanked/404 adapter
 * version would fail the whole install and mark EVERY bundled MCP as failed —
 * a Codex-only user would pay for a Claude-only outage. Separate roots also
 * keep each manifest self-contained, so neither prunes the other (both are
 * regenerated from scratch and installed with `--no-save`).
 *
 * Within the agent root the two adapters SHARE a manifest, and that is the
 * subtlety `agentManifestEntries` (`./adapter-tree`) exists for: npm reifies
 * `node_modules` to whatever manifest it is handed, pruning what is absent, so
 * an install scoped to one adapter must still list the other at the version it
 * already has.
 *
 * Keep pinnedVersion in lockstep with package.json's devDependency on the
 * same package, so dev and production run identical adapter code. It is a
 * devDependency deliberately: `npm install` in a dev checkout still installs
 * it (so `resolveRepoLocalAdapterBin` finds it and the dev skip fires — no
 * network, no behaviour change), but `npx libi` and the packaged Electron
 * artifact do NOT get it, which is the whole point of this file.
 *
 * The READ half of this subject — where the tree is, what is in it, whether
 * it is current — lives in `./adapter-tree`. This file is
 * the write half: the cross-process lock, `npm install`, the single-flight and
 * the negative cache. It re-exports the read half so it stays the module
 * callers import.
 */
import { mkdirSync } from "node:fs";

import { serverLogger as logger } from "@/lib/logger";
import {
  acquireInstallLock,
  lockTimingForNpmTimeout,
  readInstalledVersion,
  runNpmInstall,
  writePackageJson,
} from "@/lib/install/npm-root";
import { runtimeAgentPackage, type RuntimeAgentPackage } from "./runtime-packages";
// The read half of this subject lives in `./adapter-tree`: where the
// tree is, what is in it, whether it is current, and what to tell
// the user about it. Nothing there writes; everything here does.
import {
  adapterVersionCurrent,
  agentInstallEntries,
  agentManifestEntries,
  AGENT_NPM_INSTALL_TIMEOUT_MS,
  describeDrift,
  driftedEntries,
  getAgentInstallRoot,
  LOCK_FILE,
  pendingInstallReason,
  resolveInstalledAdapterBin,
  resolveRepoLocalAdapterBin,
} from "./adapter-tree";

// The whole read half, re-exported so this module stays the public face of
// agent adapter installation and no caller (or its 1300-line test file) has to
// move. New code should import these from `./adapter-tree` directly.
export {
  adapterBinFileNames,
  adapterUnavailableReason,
  adapterVersionCurrent,
  AGENT_NPM_INSTALL_TIMEOUT_MS,
  claudeAdapterInstallInProgress,
  claudeAdapterUnavailableReason,
  claudeAdapterVersionCurrent,
  getAgentInstallRoot,
  resolveBinIn,
  resolveClaudeAdapterBin,
  resolveInstalledAdapterBin,
  resolveRepoLocalAdapterBin,
} from "./adapter-tree";

export { CLAUDE_ADAPTER_PACKAGE, CODEX_ADAPTER_PACKAGE } from "./runtime-packages";

const LOG_TAG = "agent-install";
/**
 * Per-agent log `op` prefix, so `claude_adapter_repair` keeps its name (it is
 * the greppable evidence of a drift repair in ~/.libi/logs/libi.log) and Codex
 * gets `codex_adapter_repair` alongside it rather than sharing one op.
 */
function opFor(pkg: RuntimeAgentPackage, suffix: string): string {
  return `${pkg.agentId === "codex" ? "codex" : "claude"}_adapter_${suffix}`;
}

export interface EnsureAdapterResult {
  installed: boolean;
  binPath: string | null;
  error?: string;
  /**
   * Set ONLY on the stale-but-usable outcome: `installed` is true and
   * `binPath` runs, but it is the version the user already had — the upgrade
   * to the current pin failed (offline, blocked registry, a yanked version).
   *
   * It exists because without it that outcome is BYTE-IDENTICAL to a real
   * success, and every consumer downstream duly reported one: Category A
   * logged `claude_adapter_ready`, and the agent_install job ran a full npm,
   * watched it fail, and still emitted `agent_install_completed` — the one
   * event that would have told us a pin bump reached nobody. A field that
   * cannot be forgotten is the fix; a comment saying "check the version
   * afterwards" is not.
   *
   * Carries the real npm/verification diagnostic, so consumers map it through
   * `installFailureReason` before it reaches anything bounded (analytics).
   */
  upgradeError?: string;
  /** The version still on disk when `upgradeError` is set — what the user is
   *  actually running, as opposed to the pin they were meant to get. */
  staleVersion?: string;
}

export interface EnsureAdapterOptions {
  /**
   * Checkout root to probe for an already-present adapter bin. Defaults to
   * `process.cwd()`; a parameter so tests can exercise both a dev checkout and
   * a packaged install without chdir-ing the process.
   */
  repoRoot?: string;
  /**
   * Called once, from inside the CROSS-PROCESS install lock, at the moment
   * this call has decided it really is going to run `npm install` — after the
   * post-lock re-check that skips when another process installed while we
   * waited. Not called at all when nothing is installed.
   *
   * It exists for progress measurement. `agent_install`'s bar is built
   * by watching `~/.libi/agents` GROW, minus a baseline of what was already
   * there — both adapters share that root, so a Codex install next to an
   * installed Claude would otherwise read 275/275 MB from its first tick. The
   * runner took that baseline before calling in, i.e. before the lock; with a
   * second libi process holding it and installing, the tree grew by hundreds
   * of megabytes between the measurement and the start of OUR install, and the
   * bar was built on a baseline that no longer described the directory. Taken
   * from here it is measured under the lock, immediately before the install
   * that it is the baseline for.
   */
  onInstallStart?: () => void;
}

interface AgentInstallOutcome {
  ok: boolean;
  /** Real npm/verification diagnostic when `ok` is false — never swallowed. */
  error: string | null;
}

/**
 * Reconcile `pkg` under `~/.libi/agents/node_modules/` with its pin, leaving
 * the other adapter's tree as it was (see `agentManifestEntries`).
 * Never throws — every failure is returned as a diagnostic string so callers
 * can report WHY (a blocked registry, a yanked version) instead of a bare
 * "not installed".
 */
async function installAgentPackages(
  root: string,
  pkg: RuntimeAgentPackage,
  onInstallStart?: () => void,
): Promise<AgentInstallOutcome> {
  if (pendingInstallReason(root, pkg) === null) {
    logger.info(
      { tag: LOG_TAG, op: "skip_all_ready", agentId: pkg.agentId, npmPackage: pkg.npmPackage },
      "Agent package already matches manifest",
    );
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
    const reason = pendingInstallReason(root, pkg);
    if (reason === null) {
      logger.info(
        { tag: LOG_TAG, op: "skip_after_lock", agentId: pkg.agentId, npmPackage: pkg.npmPackage },
        "Another process installed the agent package while we waited — skipping",
      );
      return { ok: true, error: null };
    }

    // Under the lock, and past every skip: from here an `npm install` really
    // is about to run. See `EnsureAdapterOptions.onInstallStart`.
    onInstallStart?.();

    const manifest = agentManifestEntries(root, pkg);
    logger.info(
      {
        tag: LOG_TAG,
        op: "install_start",
        root,
        agentId: pkg.agentId,
        reason,
        pkgs: manifest.map((e) => ({ npmPackage: e.npmPackage, pinned: e.pinnedVersion })),
      },
      `Installing ${pkg.npmPackage}@${pkg.pinnedVersion} into ${root}`,
    );
    writePackageJson(root, manifest, {
      name: "libi-runtime-agents",
      description: "Auto-generated by lib/agents/runtime-install.ts. Do not edit by hand.",
    });
    // `omitOptional`: the adapters' engines are optionalDependencies, and the
    // chat runs the user's own CLI — they are never installed.
    await runNpmInstall(root, { timeoutMs: AGENT_NPM_INSTALL_TIMEOUT_MS, logTag: LOG_TAG, omitOptional: true });
  } catch (err) {
    logger.warn(
      { tag: LOG_TAG, op: "install_failed", root, agentId: pkg.agentId, err },
      "Runtime agent package install failed — the other agents remain available",
    );
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    releaseLock?.();
  }

  const stillDrifted = driftedEntries(root, agentInstallEntries(pkg));
  if (stillDrifted.length > 0) {
    const error = describeDrift(root, stillDrifted);
    logger.warn(
      { tag: LOG_TAG, op: "install_verify_failed", root, agentId: pkg.agentId, error },
      "Runtime agent package install completed but verification failed",
    );
    return { ok: false, error };
  }

  logger.info(
    { tag: LOG_TAG, op: "install_done", root, agentId: pkg.agentId },
    "Runtime agent package installed",
  );
  return { ok: true, error: null };
}

/**
 * Bounded-cardinality reason for the `agent_install_failed` analytics event.
 *
 * `EnsureAdapterResult.error` (and the "cancelled" the job runner throws on
 * `ctx.shouldCancel()`) is a real diagnostic meant for the log and the
 * FailureSection card — npm's own failures and the missing-bin message
 * interpolate `root`, an absolute filesystem path, into it. None of that
 * may ever reach an analytics param. This classifier is the one place that
 * turns the unbounded string into a closed enum; callers pass the raw error
 * here and send ONLY the return value as the event's `reason`.
 *
 * Pure string matching against the exact wordings this module (and
 * lib/install/npm-root.ts) actually produces — see funnel-events.test.ts for
 * the real strings each branch is keyed to. Order matters: the specific,
 * high-confidence signals (native binary missing, version drift, an actual
 * npm failure) are checked BEFORE the generic "cancelled"/"timeout"
 * substrings, because real npm stderr routinely contains ordinary English
 * words like "cancelled" (e.g. a registry request that was itself
 * cancelled/reset) — checking the generic bucket first would silently
 * relabel a genuine install failure as a user cancellation, the one
 * misclassification that changes what the funnel's `cancelled` bucket means.
 */
export type InstallFailureReason =
  | "version_drift"
  | "native_binary_missing"
  | "npm_failed"
  | "cancelled"
  | "timeout"
  | "unknown";

export function installFailureReason(raw: string): InstallFailureReason {
  const text = raw.toLowerCase();
  // An older installer's missing-engine message ("native binary" or "engine
  // binary", usually with an absolute path in it) — the path is discarded
  // here, never forwarded; only the bounded verdict survives.
  if (text.includes("native binary") || text.includes("engine binary")) return "native_binary_missing";
  // pendingInstallReason()'s "version drift (...)" wording, or
  // describeDrift()'s raw "pkg: expected X, got Y" shape when it reaches
  // EnsureAdapterResult.error directly (post-install verification failure).
  if (text.includes("version drift") || /expected\s.*got\s/.test(text)) return "version_drift";
  // npm's own stderr ("npm ERR! ...") surfaces verbatim in npmFailure()'s
  // "Command failed: ... — <reason>\n<stderr>" message. Checked before the
  // generic "cancelled"/"timeout" substrings below, since real npm failures
  // (a dropped registry connection, a proxy reset) routinely use exactly
  // those words in their own stderr.
  if (text.includes("npm err") || text.includes("npm install")) return "npm_failed";
  // The exact message `runAgentInstall` throws on ctx.shouldCancel().
  if (text.includes("cancelled") || text.includes("canceled")) return "cancelled";
  // lib/install/npm-root.ts's own "timed out after Xms" wording.
  if (text.includes("timed out") || text.includes("timeout")) return "timeout";
  return "unknown";
}

/**
 * Per-agent module state, keyed by `agentId`. These were singletons while
 * only Claude installed at runtime; with two adapters sharing the module, a
 * Claude failure sitting in a shared negative cache would short-circuit a
 * Codex install that has never been tried — so each agent gets its own slot.
 */
const inflight = new Map<string, Promise<EnsureAdapterResult>>();

/**
 * Negative cache for a failed install, scoped to this process's lifetime.
 *
 * Without this, `inflight` alone means every call after a failure re-runs a
 * full install attempt (up to the 30-min `AGENT_NPM_INSTALL_TIMEOUT_MS`
 * ceiling). The caller is the `agent_install` job (user-initiated from the
 * setup card); on an offline/proxy-blocked machine every Retry would
 * otherwise become a multi-minute stall. Caching the failure for the
 * process's lifetime (rather than a short TTL) matches how every other
 * install failure is recovered today: by restarting libi.
 *
 * `resolveInstalledAdapterBin()` is still checked on every call BEFORE this
 * cache, so the cache never masks the adapter becoming available on disk
 * some other way (e.g. a different tool finishing the install).
 */
const cachedFailure = new Map<string, EnsureAdapterResult>();

/**
 * A version-drift upgrade this process already tried and could not complete.
 *
 * Unlike `cachedFailure` this is NOT a failure result: the tree we started
 * from is complete and runnable, so the user keeps the (outdated) adapter
 * they already had and the agent stays available.
 *
 * That guarantee is real but CONDITIONAL, and the condition is the guard at
 * the branch that sets this: the adapter bin still resolves after the failed
 * attempt. It holds when npm failed without mutating the tree — offline,
 * blocked registry, a yanked version. A failure that took the bin with it
 * never reaches this branch and takes the failure path below; the next boot
 * reinstalls (`pendingInstallReason` reports the drift).
 *
 * What must not happen is every later caller paying another npm attempt (up
 * to the 30-min `AGENT_NPM_INSTALL_TIMEOUT_MS` ceiling) for an upgrade this
 * process has already proven it cannot land. Cleared by restarting libi,
 * which is how every other Category A failure is retried today.
 *
 * It holds the stale-outcome FIELDS rather than a bare boolean so a second
 * caller gets the same answer the first one did. A boolean would re-open the
 * fast path and return a clean `{installed:true}` — so the process that
 * discovered the failed upgrade would report it, and every caller after it
 * (the agent_install job, a retry) would silently report success for exactly
 * the same tree.
 */
const staleTreeAccepted = new Map<string, Pick<EnsureAdapterResult, "upgradeError" | "staleVersion">>();

/**
 * Install `agentId`'s ACP adapter into `~/.libi/agents/node_modules` if it
 * isn't already available.
 *
 * Order: a dev checkout's own `node_modules/.bin` wins FIRST — in the repo,
 * `node_modules/.bin/<adapter>` must always win, so a developer whose
 * `~/.libi` was previously populated by a production run isn't silently
 * pinned to that installed copy instead of their checkout's; then an
 * existing agent-root bin whose version matches the pin (skip the redundant
 * download); then a cached failure from earlier this process (skip the
 * redundant re-attempt); otherwise install.
 *
 * NEVER throws: one agent's install failure must not block boot — the other
 * agents and Terminal must stay usable. On failure it returns the real
 * npm/verification diagnostic in `error`, so a user behind a registry-blocking
 * proxy learns why instead of getting a silent `installed: false`. An id with
 * no runtime adapter (`terminal`, anything unknown) resolves the same way.
 */
export async function ensureAgentAdapterInstalled(
  agentId: string,
  options: EnsureAdapterOptions = {},
): Promise<EnsureAdapterResult> {
  const pkg = runtimeAgentPackage(agentId);
  if (!pkg) {
    return {
      installed: false,
      binPath: null,
      error: `no runtime adapter package is registered for agent "${agentId}"`,
    };
  }

  const repoRoot = options.repoRoot ?? process.cwd();
  const repoLocal = resolveRepoLocalAdapterBin(repoRoot, pkg);
  if (repoLocal) {
    logger.info(
      { tag: LOG_TAG, op: opFor(pkg, "dev_skip"), agentId, binPath: repoLocal },
      `${pkg.binName} present in the local checkout — skipping the runtime install`,
    );
    return { installed: true, binPath: repoLocal };
  }

  // An already-installed bin is only a fast path when the tree behind it is
  // CURRENT. A tree at YESTERDAY'S pin must fall through, or a pin bump never
  // reaches a user who already has libi: the drift check lives inside
  // `installAgentPackages`, which the old return never reached. The healthy
  // path costs one `accessSync` for the bin and one package.json read (~1ms)
  // — not a per-boot reinstall. There is no engine to check: the adapter is
  // installed without its optional engine and the chat runs the user's CLI.
  //
  // `staleTreeAccepted` re-opens the fast path for a drifted tree only once
  // this process has already tried and failed to upgrade it (see below): the
  // user keeps a working outdated adapter instead of re-paying the npm
  // timeout on every call.
  const agentRoot = getAgentInstallRoot();
  const existing = resolveInstalledAdapterBin(pkg);
  if (existing) {
    if (adapterVersionCurrent(agentRoot, pkg)) {
      return { installed: true, binPath: existing };
    }
    const stale = staleTreeAccepted.get(agentId);
    if (stale) {
      // Same tree, same verdict, reported the same way as the call that first
      // gave up on it — a later caller must not read a failed upgrade as a
      // clean success just because this process already stopped retrying it.
      return { installed: true, binPath: existing, ...stale };
    }
    logger.warn(
      {
        tag: LOG_TAG,
        op: opFor(pkg, "repair"),
        agentId,
        root: agentRoot,
        binPath: existing,
        reason: pendingInstallReason(agentRoot, pkg),
      },
      `${pkg.npmPackage} tree has drifted from the pin — reinstalling`,
    );
  }

  const failure = cachedFailure.get(agentId);
  if (failure) {
    logger.info(
      { tag: LOG_TAG, op: opFor(pkg, "negative_cache_hit"), agentId, error: failure.error },
      `Skipping the ${pkg.npmPackage} install — it already failed earlier this run; restart libi to retry`,
    );
    return failure;
  }

  const running = inflight.get(agentId);
  if (running) return running;
  const attempt = (async (): Promise<EnsureAdapterResult> => {
    const root = getAgentInstallRoot();
    const outcome = await installAgentPackages(root, pkg, options.onInstallStart);

    const binPath = resolveInstalledAdapterBin(pkg);
    if (binPath) {
      if (adapterVersionCurrent(root, pkg)) {
        logger.info(
          { tag: LOG_TAG, op: opFor(pkg, "installed"), agentId, binPath },
          `${pkg.npmPackage} installed`,
        );
      } else {
        // The upgrade did not land (offline, blocked registry, a yanked
        // version) but the tree we came in with is still runnable. Returning installed:false here would take the agent
        // away from someone who had it working a moment ago — strictly worse
        // than the outdated version they already had, and the reason this
        // branch does not simply reuse the failure path below. So: keep it,
        // say so loudly enough to grep, stop re-attempting this run — and
        // hand every caller `upgradeError` so none of them can mistake this
        // for the install having succeeded (see `EnsureAdapterResult`).
        const staleVersion = readInstalledVersion(root, pkg.npmPackage);
        // In practice `installAgentPackages` always fills `outcome.error`
        // when it leaves a drifted tree behind — either npm's own failure or
        // `install_verify_failed`'s drift description. The fallback is for
        // the type, not a known path, and mirrors `describeDrift`'s
        // "expected X, got Y" wording so `installFailureReason` still maps it
        // to `version_drift` instead of dumping it in "unknown".
        const upgradeError =
          outcome.error ??
          `${pkg.npmPackage}: expected ${pkg.pinnedVersion}, got ${staleVersion ?? "missing"}`;
        const stale = { upgradeError, staleVersion: staleVersion ?? undefined };
        staleTreeAccepted.set(agentId, stale);
        logger.warn(
          {
            tag: LOG_TAG,
            op: opFor(pkg, "upgrade_failed_stale_kept"),
            agentId,
            root,
            binPath,
            pinned: pkg.pinnedVersion,
            installed: staleVersion,
            error: upgradeError,
          },
          `${pkg.npmPackage} upgrade failed — keeping the installed version; restart libi to retry`,
        );
        return { installed: true, binPath, ...stale };
      }
      return { installed: true, binPath };
    }

    const error =
      outcome.error ??
      `${pkg.npmPackage}@${pkg.pinnedVersion}: install reported success but ${pkg.binName} is missing from ${root}`;
    logger.warn(
      { tag: LOG_TAG, op: opFor(pkg, "missing_after_install"), agentId, root, error },
      `${pkg.npmPackage} unavailable — the other agents remain available`,
    );
    const result: EnsureAdapterResult = { installed: false, binPath: null, error };
    cachedFailure.set(agentId, result);
    return result;
  })().finally(() => {
    inflight.delete(agentId);
  });
  inflight.set(agentId, attempt);
  return attempt;
}

/** Back-compat alias — Claude only. No production caller any more
 *  (Category A no longer installs any adapter; the agent_install job calls
 *  `ensureAgentAdapterInstalled` directly); kept for the Claude-specific
 *  cases in runtime-install.test.ts. */
export function ensureClaudeAdapterInstalled(
  options: EnsureAdapterOptions = {},
): Promise<EnsureAdapterResult> {
  return ensureAgentAdapterInstalled("claude-code", options);
}
