import { z } from "zod/v3";
import {
  claudeAdapterVersionCurrent,
  ensureClaudeAdapterInstalled,
  getAgentInstallRoot,
  resolveInstalledAdapterBin,
  installFailureReason,
  type EnsureAdapterResult,
} from "@/lib/agents/runtime-install";
import { claudeNativeBinaryPresent } from "@/lib/agents/claude-native-binary";
import { refreshAgentCache } from "@/lib/agents/acp/agent-registry";
import { getAgentSetup } from "@/lib/agents/setup/registry";
import { trackDirectoryBytes } from "@/lib/jobs/dir-download-progress";
import { trackServerEvent } from "@/lib/analytics/server";
import { toAgentEventId } from "@/lib/analytics/events";
import { serverLogger as logger } from "@/lib/logger";
import type { JobContext, JobRunner } from "@/lib/jobs/types";

const LOG_TAG = "agent-install";

/** Chat/Settings render `done`/`total` verbatim, so report MB rather than raw
 *  bytes — matches `whisper_model_download`, `tts_model_download`,
 *  `music_model_download` and `tracking_engine_install`. */
const BYTES_PER_MB = 1_000_000;

/** The figure the boot-time ticker already quotes users
 *  (`lib/server/lifecycle/category-a.ts`'s `claudeAdapterProgressDetail`):
 *  "downloading ~345 MB, first run only". Kept as its own constant here
 *  rather than imported — that ticker's copy is a UI string, this is a
 *  progress-bar total, and coupling them would make an unrelated copy edit
 *  silently change the bar's denominator. */
const ESTIMATED_TOTAL_BYTES = 345_000_000;

const paramsSchema = z.object({ agentId: z.string() });

/**
 * The ONE agent this runner can actually install.
 *
 * Everything below the guard — `resolveInstalledAdapterBin`,
 * `claudeNativeBinaryPresent`, `ensureClaudeAdapterInstalled` — is Claude
 * Code's adapter and nothing else. `AgentInstallDeclaration.command` is
 * DECLARATIVE ONLY today: it is read by the setup card's Copy fallback and by
 * `prompt-error-note.ts`, and by nothing that installs anything.
 *
 * So `setup.install !== null` is NOT a sufficient guard, however much it reads
 * like one. A third entry added to `AGENT_SETUPS` with an `install` block gets
 * an Install button from the onboarding panel, a 200 from the route, and a
 * pass from that check — and would then be handed Claude Code's ~345 MB
 * install while being told its own succeeded. That is the same class of defect
 * as the two-way detection if/else this branch removed ("a third agent would
 * silently be treated as Codex"), one layer down.
 *
 * Making the install genuinely per-agent is real design work: each agent's
 * installer, verification, and native-binary layout differ. Until that exists,
 * a loud, early failure is the correct behaviour — ADDING A THIRD INSTALLABLE
 * AGENT REQUIRES GENERALISING THIS RUNNER FIRST.
 */
const INSTALLABLE_AGENT_ID = "claude-code";

export type AgentInstallParams = z.infer<typeof paramsSchema>;

export interface AgentInstallResult {
  alreadyInstalled: boolean;
  binPath: string | null;
}

/** Deps this runner needs from the outside world, injectable so tests never
 *  spawn a real ~345 MB `npm install` — see `RecomputeDeps` in
 *  `lib/tracking/recompute-segment.ts` for the same shape used elsewhere in
 *  this repo. Production (`agentInstallRunner.run`) always uses the real
 *  defaults below; only tests pass overrides. */
export interface AgentInstallDeps {
  // The same primitives `ensureClaudeAdapterInstalled`'s own no-op fast path
  // checks (see `lib/agents/runtime-install.ts`) — checked here BEFORE
  // calling the installer, exactly like `tracking_engine_install` and the
  // model-download runners pre-check their resource. Without this,
  // `alreadyInstalled` in `AgentInstallResult` can never be true:
  // `ensureClaudeAdapterInstalled`'s three fast paths (repo-local dev
  // checkout, already-installed-complete-AND-current, and a stale tree this
  // process already failed to upgrade) resolve `{ installed:
  // true }` having done no work, and nothing distinguishes that result from
  // a real ~345 MB install having just run. Kept as separate primitives
  // rather than one merged "is it installed" dep so a present bin with a
  // missing native binary — the partial-install trap
  // `claude-native-binary.ts` documents, where npm exits 0 on a failed
  // optionalDependency — and a complete bin at yesterday's pin are each
  // visibly NOT "already installed", and still fall through to the
  // installer, which repairs both.
  resolveInstalledAdapterBin: () => string | null;
  claudeNativeBinaryPresent: (root: string) => boolean;
  /** The CURRENCY half of "already installed" — completeness alone (the two
   *  primitives above) would report a healthy tree at YESTERDAY'S pin as
   *  already installed, skipping the upgrade the pin bump shipped AND
   *  emitting `agent_install_completed` for an install that never ran. */
  claudeAdapterVersionCurrent: (root: string) => boolean;
  ensureClaudeAdapterInstalled: () => Promise<EnsureAdapterResult>;
  refreshAgentCache: () => unknown;
  /** Injected so tests assert `agent_install_completed`/`agent_install_failed`
   *  without a real analytics queue/DB — same reasoning as every other dep
   *  here. Defaults to the real transport, which is itself total (never
   *  throws) — this seam exists for assertability, not safety. */
  trackServerEvent: (name: string, params?: Record<string, unknown>) => void;
}

// Wrapped in closures, not referenced directly, so importing this module
// never itself reads `refreshAgentCache`/`ensureClaudeAdapterInstalled` off
// their modules. `lib/jobs/runners/registry.ts` (and therefore this file)
// loads eagerly wherever the runner registry does, including inside
// unrelated lifecycle tests that `vi.mock` "@/lib/agents/acp/agent-registry"
// down to just `{ getAgentConfig }` — a bare `{ refreshAgentCache }` object
// property would read that missing export at MODULE LOAD and throw before
// any of those tests got to run. Deferring the reads to call time (which
// only happens when an agent_install job actually runs) keeps this runner's
// testability from breaking tests that never touch it.
const defaultDeps: AgentInstallDeps = {
  resolveInstalledAdapterBin: () => resolveInstalledAdapterBin(),
  claudeNativeBinaryPresent: (root) => claudeNativeBinaryPresent(root),
  claudeAdapterVersionCurrent: (root) => claudeAdapterVersionCurrent(root),
  ensureClaudeAdapterInstalled: () => ensureClaudeAdapterInstalled(),
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
  // Codex (and any unknown id) must be rejected LOUDLY, not silently
  // "installed" — libi ships Codex's engine, so there is nothing for this
  // runner to do for it, and a silent success would tell the caller an
  // install happened when it did not.
  if (setup === null || setup.install === null) {
    throw new Error(`${agentId} has no install step`);
  }
  // Declaring an install is not the same as this runner being able to perform
  // it — see INSTALLABLE_AGENT_ID above. Fail loudly and early rather than
  // installing Claude Code under another agent's name.
  if (agentId !== INSTALLABLE_AGENT_ID) {
    throw new Error(
      `${agentId} declares an install, but the agent_install runner can only install ` +
        `${INSTALLABLE_AGENT_ID}: every step below this guard is Claude Code's adapter. ` +
        `Generalise the runner before adding a third installable agent.`,
    );
  }

  // Pre-check BEFORE touching the installer — see `AgentInstallDeps` above
  // for why. A present bin ALONE is not enough (the partial-install trap:
  // npm exits 0 on a failed optionalDependency), and neither is a COMPLETE
  // tree on its own (it may sit at yesterday's pin), so all three primitives
  // must agree before this reports "already installed" and skips the
  // installer.
  //
  // The two do NOT agree in both directions, and only one direction matters.
  // The dangerous one — this pre-check claiming "already installed" for a
  // tree the installer would have reinstalled — cannot happen: every
  // condition here is at least as strict as the installer's. The harmless
  // one does happen: once `ensureClaudeAdapterInstalled` has tried and
  // failed to upgrade a drifted tree, it re-opens its OWN fast path for the
  // rest of the process (its `staleTreeAccepted`), so a job started after
  // that point falls through here, calls the installer, and gets the stale
  // outcome straight back instead of a second doomed npm run. That result
  // carries `upgradeError`, which the branch below turns into a failure
  // signal rather than a completed install.
  const existingBinPath = deps.resolveInstalledAdapterBin();
  if (
    existingBinPath !== null &&
    deps.claudeNativeBinaryPresent(getAgentInstallRoot()) &&
    deps.claudeAdapterVersionCurrent(getAgentInstallRoot())
  ) {
    ctx.reportProgress(1, 1, "step");
    logger.info(
      { tag: LOG_TAG, op: "already_installed", agentId, binPath: existingBinPath },
      "Agent install job found the adapter already installed — skipping the installer",
    );
    // Still the funnel's "verified usable" signal — this fast path re-checks
    // the SAME two primitives (bin present + native binary present) the
    // full installer verifies after a real npm run, so it counts too.
    emitInstallCompleted(deps, agentId);
    return { alreadyInstalled: true, binPath: existingBinPath };
  }

  const totalMb = Math.max(1, Math.floor(ESTIMATED_TOTAL_BYTES / BYTES_PER_MB));
  ctx.reportProgress(0, totalMb, "MB");

  // The installer (`npm install` into ~/.libi/agents) emits no progress
  // callbacks, so watch the destination directory grow — same technique as
  // `tracking_engine_install` and the model-download runners.
  const progress = trackDirectoryBytes({
    dir: getAgentInstallRoot(),
    totalBytes: ESTIMATED_TOTAL_BYTES,
    onBytes: (bytesDone) => {
      ctx.reportProgress(
        Math.min(Math.floor(bytesDone / BYTES_PER_MB), totalMb),
        totalMb,
        "MB",
      );
    },
  });

  let result: EnsureAdapterResult;
  try {
    result = await deps.ensureClaudeAdapterInstalled();
  } finally {
    progress.stop();
  }

  if (ctx.shouldCancel()) {
    emitInstallFailed(deps, agentId, "cancelled");
    throw new Error("cancelled");
  }

  // VERIFY BEFORE DECLARING SUCCESS — defect #59: `ensureClaudeAdapterInstalled`
  // resolving without throwing is not evidence the adapter is there. It
  // NEVER throws by design (a Claude install failure must not block boot for
  // Codex/Terminal users), so the only honest signal is `result.installed`.
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
  // off, so this neither throws nor withholds `binPath`; Claude Code stays
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

/** Funnel step 7 (Task 14) — the VERIFIED-usable signal, not "npm exited 0".
 *  `agentId` is only ever "claude-code" today (Codex has no install step,
 *  see the guard above), but goes through `toAgentEventId` anyway so an
 *  unbounded id can never reach the param even if that changes later. */
function emitInstallCompleted(deps: AgentInstallDeps, agentId: string): void {
  const agent = toAgentEventId(agentId);
  if (agent) deps.trackServerEvent("agent_install_completed", { agent });
}

/** Funnel step 8 (Task 14). `rawError` is the real npm/verification
 *  diagnostic — routinely an absolute path (claudeNativeBinaryMissingError)
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
  // A cold ~345 MB npm install runs silent for minutes on a slow line; a
  // progress watchdog would kill a healthy run. `ensureClaudeAdapterInstalled`
  // has its own AGENT_NPM_INSTALL_TIMEOUT_MS = 30 min.
  noProgressTimeoutMs: null,
  // No mcpToolId: no agent-facing MCP tool drives this. Installing the
  // adapter that lets Claude Code run is necessarily user-initiated — the
  // agent that would call this tool doesn't exist yet when it's needed.
  async run(ctx) {
    return runAgentInstall(ctx);
  },
};
