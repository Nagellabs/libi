import { z } from "zod/v3";
import {
  adapterVersionCurrent,
  ensureAgentAdapterInstalled,
  getAgentInstallRoot,
  resolveInstalledAdapterBin,
  installFailureReason,
  type EnsureAdapterResult,
} from "@/lib/agents/runtime-install";
import { runtimeAgentPackage, type RuntimeAgentPackage } from "@/lib/agents/runtime-packages";
import { refreshAgentCache } from "@/lib/agents/acp/agent-registry";
import { invalidateAgentCliMemo } from "@/lib/agents/cli/resolve";
import { getAgentSetup } from "@/lib/agents/setup/registry";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import { directoryBytes, trackDirectoryBytes } from "@/lib/jobs/dir-download-progress";
import { trackServerEvent } from "@/lib/analytics/server";
import { toAgentEventId } from "@/lib/analytics/events";
import { serverLogger as logger } from "@/lib/logger";
import type { JobContext, JobRunner } from "@/lib/jobs/types";

const LOG_TAG = "agent-install";

/** Chat/Settings render `done`/`total` verbatim, so report MB rather than raw
 *  bytes — matches `whisper_model_download`, `tts_model_download`,
 *  `music_model_download` and `tracking_engine_install`. */
const BYTES_PER_MB = 1_000_000;

const paramsSchema = z.object({ agentId: z.string() });

export type AgentInstallParams = z.infer<typeof paramsSchema>;

export interface AgentInstallResult {
  alreadyInstalled: boolean;
  binPath: string | null;
}

/** Deps this runner needs from the outside world, injectable so tests never
 *  spawn a real multi-hundred-MB `npm install` — see `RecomputeDeps` in
 *  `lib/tracking/recompute-segment.ts` for the same shape used elsewhere in
 *  this repo. Production (`agentInstallRunner.run`) always uses the real
 *  defaults below; only tests pass overrides. Every primitive takes the
 *  `RuntimeAgentPackage` it is asked about: this runner installs whichever
 *  adapter `runtimeAgentPackage(agentId)` names, and a Codex job that
 *  interrogated Claude's tree would report Claude's state as Codex's. */
export interface AgentInstallDeps {
  // The same primitives `ensureAgentAdapterInstalled`'s own no-op fast path
  // checks (see `lib/agents/runtime-install.ts`) — checked here BEFORE
  // calling the installer, exactly like `tracking_engine_install` and the
  // model-download runners pre-check their resource. Without this,
  // `alreadyInstalled` in `AgentInstallResult` can never be true:
  // `ensureAgentAdapterInstalled`'s three fast paths (repo-local dev
  // checkout, already-installed-AND-current, and a stale tree this process
  // already failed to upgrade) resolve `{ installed: true }` having done no
  // work, and nothing distinguishes that result from a real install having
  // just run. Kept as separate primitives rather than one merged "is it
  // installed" dep so a present bin at yesterday's pin is visibly NOT
  // "already installed", and still falls through to the installer, which
  // upgrades it. There is no engine primitive: the adapter is installed
  // without its optional engine, so a present bin IS the install.
  resolveInstalledAdapterBin: (pkg: RuntimeAgentPackage) => string | null;
  /** The CURRENCY half of "already installed" — a present bin alone would
   *  report a tree at YESTERDAY'S pin as already installed, skipping the
   *  upgrade the pin bump shipped AND emitting `agent_install_completed` for
   *  an install that never ran. */
  adapterVersionCurrent: (root: string, pkg: RuntimeAgentPackage) => boolean;
  /** `onInstallStart` fires inside the installer's cross-process lock, once it
   *  has decided an `npm install` really is going to run — where this runner
   *  takes its directory-growth baseline. Never fired when the
   *  installer skips. */
  ensureAdapterInstalled: (
    agentId: string,
    opts?: { onInstallStart?: () => void },
  ) => Promise<EnsureAdapterResult>;
  refreshAgentCache: () => unknown;
  /** Injected so tests assert `agent_install_completed`/`agent_install_failed`
   *  without a real analytics queue/DB — same reasoning as every other dep
   *  here. Defaults to the real transport, which is itself total (never
   *  throws) — this seam exists for assertability, not safety. */
  trackServerEvent: (name: string, params?: Record<string, unknown>) => void;
}

// Wrapped in closures, not referenced directly, so importing this module
// never itself reads `refreshAgentCache`/`ensureAgentAdapterInstalled` off
// their modules. `lib/jobs/runners/registry.ts` (and therefore this file)
// loads eagerly wherever the runner registry does, including inside
// unrelated lifecycle tests that `vi.mock` "@/lib/agents/acp/agent-registry"
// down to just `{ getAgentConfig }` — a bare `{ refreshAgentCache }` object
// property would read that missing export at MODULE LOAD and throw before
// any of those tests got to run. Deferring the reads to call time (which
// only happens when an agent_install job actually runs) keeps this runner's
// testability from breaking tests that never touch it.
const defaultDeps: AgentInstallDeps = {
  resolveInstalledAdapterBin: (pkg) => resolveInstalledAdapterBin(pkg),
  adapterVersionCurrent: (root, pkg) => adapterVersionCurrent(root, pkg),
  ensureAdapterInstalled: (agentId, opts) => ensureAgentAdapterInstalled(agentId, opts),
  refreshAgentCache: () => refreshAgentCache(),
  trackServerEvent: (name, params) => trackServerEvent(name, params),
};

/**
 * Testable body of the runner. `agentInstallRunner.run` below calls this with
 * the real deps; tests call it directly with fakes.
 */
export async function runAgentInstall(
  ctx: JobContext<AgentInstallParams>,
  deps: AgentInstallDeps = defaultDeps,
): Promise<AgentInstallResult> {
  const { agentId } = ctx.params;
  const setup = getAgentSetup(agentId);
  // An agent with no declared install (terminal, and any unknown id) must be
  // rejected LOUDLY, not silently "installed" — a silent success would tell
  // the caller an install happened when it did not.
  if (setup === null || setup.install === null) {
    throw new Error(`${agentId} has no install step`);
  }
  // Declaring an install is not the same as this runner being able to perform
  // it: everything below installs the `RuntimeAgentPackage` registered for
  // the id, so an agent with a declaration and no package is a registry
  // mistake to fail on early, not to paper over with someone else's install.
  const pkg = runtimeAgentPackage(agentId);
  if (!pkg) {
    throw new Error(
      `${agentId} declares an install, but no RuntimeAgentPackage is registered for it — ` +
        `add one to lib/agents/runtime-packages.ts before offering the install.`,
    );
  }
  // The bar's denominator comes from the SAME package entry, never a fallback:
  // a third agent registered with a placeholder must fail here, not render
  // someone else's size.
  if (!(pkg.estimatedInstallBytes > 0)) {
    throw new Error(
      `${agentId} declares an install, but its RuntimeAgentPackage has no estimatedInstallBytes — ` +
        `set one in lib/agents/runtime-packages.ts before offering the install.`,
    );
  }

  // Pre-check BEFORE touching the installer — see `AgentInstallDeps` above
  // for why. A present bin ALONE is not enough (it may sit at yesterday's
  // pin), so both primitives must agree before this reports "already
  // installed" and skips the installer.
  //
  // The two do NOT agree in both directions, and only one direction matters.
  // The dangerous one — this pre-check claiming "already installed" for a
  // tree the installer would have reinstalled — cannot happen: every
  // condition here is at least as strict as the installer's. The harmless
  // one does happen: once `ensureAgentAdapterInstalled` has tried and
  // failed to upgrade a drifted tree, it re-opens its OWN fast path for the
  // rest of the process (its `staleTreeAccepted`), so a job started after
  // that point falls through here, calls the installer, and gets the stale
  // outcome straight back instead of a second doomed npm run. That result
  // carries `upgradeError`, which the branch below turns into a failure
  // signal rather than a completed install.
  const existingBinPath = deps.resolveInstalledAdapterBin(pkg);
  if (existingBinPath !== null && deps.adapterVersionCurrent(getAgentInstallRoot(), pkg)) {
    ctx.reportProgress(1, 1, "step");
    logger.info(
      { tag: LOG_TAG, op: "already_installed", agentId, binPath: existingBinPath },
      "Agent install job found the adapter already installed — skipping the installer",
    );
    // The tree on disk can be newer than this process's detection cache — a
    // second libi sharing the install root put it there. Without the refresh the
    // job completes while the status still reads the adapter as missing, the
    // wizard offers Retry, and every Retry lands back on this same fast path.
    deps.refreshAgentCache();
    // Still the funnel's "verified usable" signal — this fast path re-checks
    // the SAME primitives (bin present + version current) the full installer
    // verifies after a real npm run, so it counts too.
    emitInstallCompleted(deps, agentId);
    return { alreadyInstalled: true, binPath: existingBinPath };
  }

  // `trackDirectoryBytes` clamps at the total, so an install that lands
  // smaller pins at <100% until the final report and one that lands larger
  // never renders "104%".
  const estimatedTotalBytes = pkg.estimatedInstallBytes;
  const totalMb = Math.max(1, Math.floor(estimatedTotalBytes / BYTES_PER_MB));
  ctx.reportProgress(0, totalMb, "MB");

  // The installer (`npm install` into ~/.libi/agents) emits no progress
  // callbacks, so watch the destination directory grow — same technique as
  // `tracking_engine_install` and the model-download runners. Both adapters
  // share that root, so what is already there (the OTHER agent's tree, or
  // this one's stale tree) is the baseline, not progress: without it a Codex
  // install next to an installed Claude read as complete from its first tick.
  //
  // Measured from `onInstallStart` — inside the installer's CROSS-PROCESS
  // lock, at the moment it has decided to run `npm install` — not before the
  // call. `maxConcurrent: 1` only serialises this process; a second
  // libi holding the lock and installing grew the shared root by hundreds of
  // megabytes while we waited, and a baseline taken before the wait no longer
  // described the directory the bar was measuring. Nothing at all is tracked
  // when the installer skips (another process got there first, or the tree was
  // already current): there is no download to draw, and the terminal tick
  // still completes the bar.
  // A holder rather than a `let`: TypeScript does not track assignments made
  // inside the async closure below and would narrow a bare `let` to `null`.
  const tracked: { settled: boolean; progress: { stop: () => void } | null } = {
    settled: false,
    progress: null,
  };
  const startTracking = async (): Promise<void> => {
    const baselineBytes = await directoryBytes(getAgentInstallRoot());
    // The install can finish while that measurement is in flight; starting a
    // watcher then would leave its interval running past the `finally` below.
    if (tracked.settled) return;
    tracked.progress = trackDirectoryBytes({
      dir: getAgentInstallRoot(),
      totalBytes: estimatedTotalBytes,
      baselineBytes,
      onBytes: (bytesDone) => {
        ctx.reportProgress(
          Math.min(Math.floor(bytesDone / BYTES_PER_MB), totalMb),
          totalMb,
          "MB",
        );
      },
    });
    if (tracked.settled) {
      tracked.progress.stop();
      tracked.progress = null;
    }
  };

  let result: EnsureAdapterResult;
  try {
    result = await deps.ensureAdapterInstalled(agentId, {
      onInstallStart: () => void startTracking(),
    });
  } finally {
    tracked.settled = true;
    tracked.progress?.stop();
  }

  if (ctx.shouldCancel()) {
    emitInstallFailed(deps, agentId, "cancelled");
    throw new Error("cancelled");
  }

  // VERIFY BEFORE DECLARING SUCCESS — defect #59: `ensureAgentAdapterInstalled`
  // resolving without throwing is not evidence the adapter is there. It
  // NEVER throws by design (one agent's install failure must not take the
  // other agents or Terminal down with it), so the only honest signal is
  // `result.installed`.
  if (!result.installed) {
    logger.warn(
      { tag: LOG_TAG, op: "install_failed", agentId, error: result.error },
      "Agent install job finished but the adapter is not installed",
    );
    emitInstallFailed(deps, agentId, result.error ?? "unknown");
    throw new Error(result.error ?? "install did not complete");
  }

  // …and `result.installed` alone is not evidence THIS install did anything.
  // `upgradeError` is set on one outcome and no other: the adapter runs, but
  // it is the version the user already had — the upgrade this job exists to
  // perform failed and the working older tree was kept. They are not worse
  // off, so this neither throws nor withholds `binPath`; the agent stays
  // selectable. But it is emphatically NOT a completed install, and
  // `agent_install_completed` firing here is exactly what would hide a failed
  // rollout — the funnel would show every offline user upgrading cleanly. So
  // it goes down the same bounded-reason failure signal a hard failure uses.
  if (result.upgradeError) {
    // The cache is still refreshed and the bar still completed: the job DID
    // finish and the adapter on disk IS usable, so leaving the detection
    // cache negative or the progress bar part-way would misreport the
    // opposite way.
    deps.refreshAgentCache();
    ctx.reportProgress(totalMb, totalMb, "MB");
    logger.warn(
      {
        tag: LOG_TAG,
        op: "install_stale_kept",
        agentId,
        binPath: result.binPath,
        staleVersion: result.staleVersion,
        error: result.upgradeError,
      },
      "Agent install job could not upgrade the adapter — the installed version was kept",
    );
    emitInstallFailed(deps, agentId, result.upgradeError);
    return { alreadyInstalled: false, binPath: result.binPath };
  }

  // A completed adapter install changes what the setup flow reports for this
  // agent, so its CLI memo is dropped and the next status poll resolves
  // afresh. It must never fail an install that did complete: a throw is
  // logged and ignored. (`getAgentSetup` above accepted the id, so it is a
  // setup agent.)
  try {
    invalidateAgentCliMemo(agentId as SetupAgentId);
  } catch (err) {
    logger.warn(
      { tag: LOG_TAG, op: "cli_memo_invalidate_failed", agentId, err },
      "Agent install job could not invalidate the agent CLI memo — the install itself completed",
    );
  }

  // Without this, `lib/agents/acp/agent-registry.ts`'s detection cache keeps
  // serving the stale "not installed" answer until the app restarts — the
  // exact dead end this job exists to remove.
  deps.refreshAgentCache();

  ctx.reportProgress(totalMb, totalMb, "MB");
  logger.info(
    { tag: LOG_TAG, op: "install_done", agentId, binPath: result.binPath },
    "Agent install job completed",
  );
  emitInstallCompleted(deps, agentId);
  return { alreadyInstalled: false, binPath: result.binPath };
}

/** The install-completed event — the VERIFIED-usable signal, not "npm exited 0".
 *  `agentId` goes through `toAgentEventId` so an unbounded id can never
 *  reach the param, whichever agents the registry grows to install. */
function emitInstallCompleted(deps: AgentInstallDeps, agentId: string): void {
  const agent = toAgentEventId(agentId);
  if (agent) deps.trackServerEvent("agent_install_completed", { agent });
}

/** The install-failed event. `rawError` is the real npm/verification
 *  diagnostic — routinely an absolute path (npm's own errors name the root)
 *  — and is mapped through `installFailureReason` so only the bounded
 *  verdict ever becomes an event param. */
function emitInstallFailed(deps: AgentInstallDeps, agentId: string, rawError: string): void {
  const agent = toAgentEventId(agentId);
  if (agent) {
    deps.trackServerEvent("agent_install_failed", {
      agent,
      reason: installFailureReason(rawError),
    });
  }
}

export const agentInstallRunner: JobRunner<AgentInstallParams, AgentInstallResult> = {
  kind: "agent_install",
  maxConcurrent: 1,
  paramsSchema,
  // npm install is not resumable: a half-installed node_modules is not state
  // we can checkpoint. npm's own cache makes the retry cheap.
  resumable: false,
  // Every run writes ONE shared directory (~/.libi/agents), so a forced
  // restart must never race an in-flight run — whichever clears the tree
  // destroys the other's work. This is the music_model_download lesson
  // (see the doc comment on `exclusiveResource` in lib/jobs/types.ts),
  // applied before it costs anything.
  exclusiveResource: true,
  // A cold adapter npm install can run silent for minutes on a slow line; a
  // progress watchdog would kill a healthy run. `ensureAgentAdapterInstalled`
  // has its own AGENT_NPM_INSTALL_TIMEOUT_MS = 30 min.
  noProgressTimeoutMs: null,
  // No mcpToolId: no agent-facing MCP tool drives this. Installing the
  // adapter that lets an agent run is necessarily user-initiated — the
  // agent that would call this tool doesn't exist yet when it's needed.
  async run(ctx) {
    return runAgentInstall(ctx);
  },
};
