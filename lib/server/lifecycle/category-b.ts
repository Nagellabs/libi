/**
 * Category B — "App alive."
 *
 * Runs in the Next.js process (or the Electron main process for in-process
 * Electron). Assumes Category A has completed successfully — every bundled
 * MCP's deps are on disk and have been probe-verified.
 *
 * Does only fast operations:
 *   db-migrate + seed → jobs-recover → port-file → workspace → warm agent
 *   process → load session list → DB-persist probe → invalidate cache →
 *   create standby session.
 */

import { migrateDatabase as migrateDatabaseImpl } from "@/lib/db/client";
import { recoverOrphanedJobs as recoverOrphanedJobsImpl } from "@/lib/jobs/scheduler";
import {
  ensureLibiDirs,
  getAgentDirWriteTargets,
  getConnectedAgentDir,
  getLibiAgentDir,
  getLibiPortFile,
} from "@/lib/libi-home";
import { getCrashReportSettings, getSettings } from "@/lib/db/settings";
import { setCrashReportChoice } from "@/lib/sentry/enabled";
import { getProcessManager } from "@/lib/agents/process-manager";
import { getSessionManager } from "@/lib/sessions/session-manager";
import { getAgentConfig } from "@/lib/agents/acp/agent-registry";
import { isAuthRequiredError } from "@/lib/agents/agent-readiness";
import { prepareAgentDir } from "@/mcp/workspace";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import { invalidateMcpConfig, writeSettingsFile } from "@/lib/mcp-config";
import { pickDriver } from "@/lib/export/drivers";
import { lifecycleEvents } from "./events";
import { serverLogger } from "@/lib/logger";
import fs from "node:fs";
import type { CategoryBStepId } from "./types";

/** Thrown by Category B steps; carries an actionable hint for the user. */
export class BootPhaseError extends Error {
  constructor(
    public step: CategoryBStepId,
    message: string,
    public hint: string,
  ) {
    super(message);
    this.name = "BootPhaseError";
  }
}

let shuttingDown = false;

/** How long a signal-triggered shutdown waits on the export driver before
 *  exiting anyway. Ctrl-C must stay responsive even with Chromium wedged. */
const SHUTDOWN_DRIVER_TIMEOUT_MS = 3000;

/**
 * Resolve the port to publish in `<LIBI_HOME>/port`.
 *
 * This file is the ONLY discovery mechanism for everything that has to reach
 * the server from outside this process — `mcp/notify.ts`, `mcp/jobs-client.ts`,
 * the chromium render page, tracking/analysis runners, the terminal WebSocket
 * (see `getCurrentPort()` in lib/libi-home.ts). Publishing a port the server
 * is not listening on is worse than publishing nothing: on a machine running
 * more than one libi it silently routes an MCP child at a DIFFERENT instance's
 * database.
 *
 * Every entry point is therefore required to put the REAL bound port in the
 * env before Category B runs — `lib/cli/studio.ts#runProductionServer` sets
 * `PORT` from the CLI flag before `next().prepare()`, and
 * `electron/main.ts#startNextServer` binds its ephemeral port BEFORE preparing
 * Next and sets `PORT`/`LIBI_PORT` from `server.address()`. The literal
 * fallback below only survives as a last resort for `next dev` invoked outside
 * both paths; reaching it is a bug, so it is logged loudly rather than written
 * silently (which is exactly how the packaged app shipped a wrong port).
 */
export function resolvePortToPublish(
  env: NodeJS.ProcessEnv = process.env,
): { port: string; source: "PORT" | "LIBI_PORT" | "default" } {
  if (env.PORT) return { port: env.PORT, source: "PORT" };
  if (env.LIBI_PORT) return { port: env.LIBI_PORT, source: "LIBI_PORT" };
  return { port: "3456", source: "default" };
}

export function writePortFileAndInstallSignals(): void {
  const { port, source } = resolvePortToPublish();
  const portFile = getLibiPortFile();
  if (source === "default") {
    serverLogger.warn(
      { tag: "lifecycle", phase: "category-b", op: "port_file_default", port, portFile },
      "Neither PORT nor LIBI_PORT is set — publishing the hardcoded default port. " +
        "MCP children and job callbacks will reach the wrong server if this process " +
        "is not actually listening there.",
    );
  } else {
    serverLogger.info(
      { tag: "lifecycle", phase: "category-b", op: "port_file_written", port, source, portFile },
      `Published server port ${port} (from ${source})`,
    );
  }
  fs.writeFileSync(portFile, port, "utf-8");
  const cleanupPortFile = () => {
    try { fs.unlinkSync(portFile); } catch { /* ignore */ }
  };
  const cleanupSignal = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // `pickDriver().shutdown()` closes the EXPORT driver (Chromium), not the
    // HTTP server — and a wedged browser must never be able to make Ctrl-C
    // stop working, so it is raced against a deadline rather than awaited.
    try {
      await Promise.race([
        pickDriver().shutdown(),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRIVER_TIMEOUT_MS).unref()),
      ]);
    } catch (err) {
      serverLogger.warn({ err }, "driver shutdown failed during exit");
    }
    cleanupPortFile();
    // Registering a signal handler REPLACES Node's default disposition, which
    // is to terminate. Without this explicit exit the process SURVIVES its own
    // shutdown, in the worst possible state: the port file is gone but the
    // HTTP server still holds the port. Observed on published 0.1.2 — the next
    // `npx @nagellabs/libi` dies with `EADDRINUSE 127.0.0.1:3499`, and in
    // production (no LIBI_PORT, so the port is ephemeral) every MCP child that
    // resolves the now-deleted port file falls back to `getCurrentPort()`'s
    // 3456 default and addresses a server that was never there.
    // Exit 0, not 128+signum: this is an orderly, requested shutdown, and a
    // non-zero code makes `npx` print a spurious failure on every Ctrl-C.
    process.exit(0);
  };
  process.on("SIGTERM", cleanupSignal);
  process.on("SIGINT", cleanupSignal);
  process.on("exit", cleanupPortFile);
}

/**
 * Re-read the persisted crash-report choice now that the schema is guaranteed.
 *
 * `sentry.server.config.ts` seeds the gate at boot, BEFORE migrations. When
 * that read throws — a locked DB, a mid-schema-change window — it falls back
 * to `"unset"`, which means REPORTING, for the whole process lifetime. Nothing
 * could correct it: the browser reconcile mutates the browser's module cache,
 * and this Node process has no second seed. So a transient failure at exactly
 * the wrong moment silently reverted an explicit opt-out until the next
 * restart.
 *
 * Deliberately non-fatal and deliberately NOT fail-closed on error: a DB that
 * cannot be read is precisely when a crash report is most valuable, and
 * `"unset" → send` remains correct for a genuinely new user.
 */
function reseedCrashReportGate(): void {
  try {
    setCrashReportChoice(getCrashReportSettings().choice);
  } catch (err) {
    serverLogger.warn(
      { tag: "sentry", op: "crash_report_reseed_failed", err },
      "could not re-read the crash-report preference after migrations",
    );
  }
}

export interface CategoryBDeps {
  migrateDatabase: () => void;
  recoverOrphanedJobs: () => Promise<void>;
  writePortFile: () => void;
  prepareAgentDir: (dir: string) => Promise<void>;
  warmAgentProcess: (agentId: string) => Promise<void>;
  loadSessions: (agentId: string) => Promise<void>;
  probeAndPersist: () => Promise<void>;
  createStandby: () => Promise<void>;
}

export const defaultCategoryBDeps: CategoryBDeps = {
  migrateDatabase: () => {
    ensureLibiDirs();
    migrateDatabaseImpl();
    reseedCrashReportGate();
  },
  recoverOrphanedJobs: recoverOrphanedJobsImpl,
  writePortFile: writePortFileAndInstallSignals,
  prepareAgentDir: (dir) => prepareAgentDir(dir),
  warmAgentProcess: async (agentId) => {
    // Initialize SessionManager BEFORE warming the process so its
    // hooks (shutdown, createClient, onProcessCrash) are registered
    // with the ProcessManager. Without this the warm errors with
    // "SessionManager hooks not registered" the first time a client
    // is created (see Category B agent-warm step failure).
    getSessionManager();
    await getProcessManager().warmProcess(agentId);
  },
  loadSessions: async (agentId) => {
    await getSessionManager().loadInitialSessions(agentId);
  },
  probeAndPersist: async () => {
    const dm = new DependencyManager();
    // Refresh every bundled row's install_status + dependency_status from
    // current on-disk state. Without this, MCPs whose only deps were
    // already system-installed (e.g. uv-only tier-1 deps on whisper /
    // local-tts / local-music) keep their seed `installStatus = "pending"`
    // forever, and the UI shows them as "Checking…" indefinitely.
    await dm.settleAllBundledStatuses();
    // Pre-warm every probeable MCP. `prewarmMcp` itself skips MCPs whose
    // install isn't ready (`installStatus !== "installed" | "not_required"`),
    // so we don't need a separate tier filter here — every MCP that
    // settled to "installed" gets probed; everything else is skipped.
    await dm.prewarmBundledMcps();
  },
  createStandby: async () => {
    await getSessionManager().createStandbySession();
  },
};

const FIXED_STEPS: Array<{
  id: CategoryBStepId;
  run: (deps: CategoryBDeps) => Promise<void> | void;
  hint: string;
}> = [
  {
    id: "db-migrate",
    run: (d) => d.migrateDatabase(),
    hint: "Database migration failed. Try `rm -rf ~/.libi/libi.sqlite*` to reset (you'll lose chats), then retry.",
  },
  {
    id: "jobs-recover",
    run: (d) => d.recoverOrphanedJobs(),
    hint: "Job recovery failed. Inspect `~/.libi/jobs/` for stale state, then retry.",
  },
  {
    id: "port-file",
    run: (d) => d.writePortFile(),
    hint: "Failed to write port file at ~/.libi/port. Check filesystem permissions.",
  },
];

export async function runCategoryB(
  deps: CategoryBDeps = defaultCategoryBDeps,
): Promise<void> {
  const start = Date.now();

  // Phase 1: fixed steps (DB → jobs → port).
  for (const s of FIXED_STEPS) {
    lifecycleEvents.emit({ kind: "category-b-step", step: s.id, status: "running" });
    try {
      await s.run(deps);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BootPhaseError(s.id, message, s.hint);
    }
    lifecycleEvents.emit({ kind: "category-b-step", step: s.id, status: "done" });
  }

  // Phase 1b: proxy maintenance sweeps — both non-fatal + fire-and-forget;
  // they must never block boot. Runs after db-migrate so the `proxy_height` /
  // `has_alpha` columns are guaranteed to exist. Order matters: the alpha
  // backfill runs FIRST (it re-probes pre-alpha-column video rows and drops
  // any stale alpha-stripped VPx proxy) so the 720p regen sweep never
  // re-enqueues proxy_gen for a row the runner would refuse. This sequencing
  // is safe because each backfill probe is hard-capped (`PROBE_TIMEOUT_MS` in
  // lib/ffmpeg/probe.ts) — a hung ffprobe (stalled network mount) can no
  // longer stall the backfill forever and silently starve the 720p sweep.
  void (async () => {
    try {
      const { sweepBackfillHasAlpha } = await import("@/lib/proxy/backfill-alpha");
      await sweepBackfillHasAlpha();
    } catch (err) {
      serverLogger.warn(
        { tag: "proxy", op: "sweep_backfill_alpha_phase_failed", err },
        "has_alpha backfill sweep threw; pre-fix alpha rows may keep stale proxies",
      );
    }
    try {
      const { sweepRegenLegacy720pProxies } = await import("@/lib/proxy/regen-720p");
      sweepRegenLegacy720pProxies();
    } catch (err) {
      serverLogger.warn(
        { tag: "proxy", op: "sweep_regen_720p_phase_failed", err },
        "Legacy 720p proxy regen sweep threw; some proxies may stay at old resolution",
      );
    }
  })();

  // Phase 1c: load custom effect packages from disk into the shared registry.
  // Non-fatal — a bad package only means that one effect is unavailable; it
  // must never block boot.
  try {
    const { refreshCustomEffects } = await import("@/lib/effects/packages");
    const { count, errors } = refreshCustomEffects();
    serverLogger.info(
      { tag: "effects", op: "load_custom", count, errors },
      `Loaded ${count} custom effect package(s)`,
    );
  } catch (err) {
    serverLogger.warn(
      { tag: "effects", op: "load_custom_failed", err },
      "Custom effect load threw; custom effects unavailable this boot",
    );
  }

  // Phase 1d: one-time strip of the LEGACY libi marker block (see
  // migrate-legacy.ts for the exact marker constants) from the user's real
  // `~/.codex/config.toml`. Canonical-only (the sweep's
  // own guard returns immediately for worktree/dev/test instances) and
  // non-fatal — a strip failure must never block boot, and on ANY ambiguity the
  // strip leaves content rather than removing it.
  try {
    const { sweepLegacyCodexConfigOnBoot } = await import("@/lib/codex-config/migrate-legacy");
    sweepLegacyCodexConfigOnBoot();
  } catch (err) {
    serverLogger.warn(
      { tag: "codex-config", op: "legacy_migrate_phase_failed", err },
      "Legacy codex config migration threw; the user's ~/.codex/config.toml is untouched",
    );
  }

  // Phase 2: prepare agent dir(s) (always needed). In connect-agent mode
  // (LIBI_CONNECT_AGENT_DIR set by `npx libi --connect-agent`) this also
  // syncs config to the connected external dir, then short-circuits — no
  // in-app agent warm; the outside CLI is the primary surface.
  for (const dir of getAgentDirWriteTargets()) {
    await deps.prepareAgentDir(dir);
  }
  if (getConnectedAgentDir()) {
    lifecycleEvents.emit({ kind: "category-b-done", durationMs: Date.now() - start });
    return;
  }

  // Phase 3: agent-dependent steps. Skipped if no preferred agent.
  const preferredAgent = getSettings().preferredAgent;
  if (!preferredAgent || !getAgentConfig(preferredAgent)?.installed) {
    lifecycleEvents.emit({ kind: "category-b-done", durationMs: Date.now() - start });
    return;
  }

  lifecycleEvents.emit({ kind: "category-b-step", step: "agent-warm", status: "running" });
  try {
    await deps.warmAgentProcess(preferredAgent);
    await deps.loadSessions(preferredAgent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The PATH hint is right for a spawn failure and actively misleading for
    // the other common cause: an agent that came up fine and answered
    // `-32000 Authentication required`. Nothing about PATH fixes a sign-in,
    // and libi bundles codex's engine, so there is nothing to install either.
    throw new BootPhaseError(
      "agent-warm",
      message,
      isAuthRequiredError(err)
        ? `${preferredAgent} started but isn't signed in. Sign in to it (in libi's Terminal, or your own), then restart libi.`
        : "Failed to warm the agent subprocess. Check that the agent binary is installed and on PATH.",
    );
  }
  lifecycleEvents.emit({ kind: "category-b-step", step: "agent-warm", status: "done" });

  // Phase 4: probe each MCP and persist serverStatus to DB. Non-fatal —
  // a failed probe only means the Settings UI shows a red dot; it doesn't
  // block the standby.
  lifecycleEvents.emit({ kind: "category-b-step", step: "probe-persist", status: "running" });
  try {
    await deps.probeAndPersist();
  } catch (err) {
    serverLogger.warn(
      { tag: "lifecycle", phase: "category-b", op: "probe_persist_failed", err },
      "Probe-and-persist failed; Settings UI may show stale serverStatus",
    );
  }
  lifecycleEvents.emit({ kind: "category-b-step", step: "probe-persist", status: "done" });

  // Phase 5: invalidate the MCP config cache so newly-spawned sessions
  // read the freshest config, then rewrite `.claude/settings.local.json`
  // for BYO-CLI users. The explicit write doesn't depend on the invalidate
  // callback firing — keeps the file fresh on every boot even if the
  // settings-file logic later decouples from cache invalidation.
  invalidateMcpConfig({ reason: "category-b-ready" });
  try {
    writeSettingsFile(getLibiAgentDir());
  } catch (err) {
    serverLogger.warn(
      { tag: "lifecycle", phase: "category-b", op: "settings_write_failed", err },
      "Failed to rewrite .claude/settings.local.json after probe; BYO-CLI users may see a stale MCP list",
    );
  }

  // Phase 6: create the standby session.
  lifecycleEvents.emit({ kind: "category-b-step", step: "standby-create", status: "running" });
  try {
    await deps.createStandby();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BootPhaseError(
      "standby-create",
      message,
      "Failed to create standby ACP session. Check the agent subprocess logs in ~/.libi/logs/libi.log.",
    );
  }
  lifecycleEvents.emit({ kind: "category-b-step", step: "standby-create", status: "done" });

  lifecycleEvents.emit({ kind: "category-b-done", durationMs: Date.now() - start });
}
