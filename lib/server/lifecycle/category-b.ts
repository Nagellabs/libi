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
  getLibiAgentDir,
  getLibiPortFile,
  removePortFileIfOwned,
  resolvePortToPublish,
  LIBI_SERVER_PORT_ENV,
} from "@/lib/libi-home";
import { getCrashReportSettings, getSettings } from "@/lib/db/settings";
import { setCrashReportChoice } from "@/lib/sentry/enabled";
import { getProcessManager } from "@/lib/agents/process-manager";
import { getSessionManager } from "@/lib/sessions/session-manager";
import { getAgentConfig } from "@/lib/agents/acp/agent-registry";
import { isUsableCli, resolveAgentCli } from "@/lib/agents/cli/resolve";
import { getAgentSetup, isSetupAgentId } from "@/lib/agents/setup/registry";
import { isAuthRequiredError } from "@/lib/agents/agent-readiness";
import { prepareAgentDir, stripLegacyAgentDirFiles } from "@/mcp/workspace";
import { syncSkillInstalls } from "@/mcp/skills/installs";
import { sanitizeErrForLog } from "@/mcp/skills/writer";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import { invalidateMcpConfig } from "@/lib/mcp-config";
import { pickDriver } from "@/lib/export/drivers";
import { lifecycleEvents } from "./events";
import { startMcpHttpChild, type McpHttpChildHandle } from "./mcp-http-child";
import { getMcpHttpChild as getMcpHttp, setMcpHttpChild as setMcpHttp } from "./mcp-http-handle";
import { serverLogger } from "@/lib/logger";
import fs from "node:fs";
import type { CategoryBStepId } from "./types";

/**
 * What the splash and the terminal tell the user when the MCP endpoint did not
 * come up at boot. Boot carries on, so it is a warning, not a fatal: the chat
 * works, just without libi's tools, and the Restart button is the fix.
 */
export const MCP_TOOLS_UNAVAILABLE_WARNING =
  "libi's tools are unavailable — open Agents → Libi MCP and press Restart.";

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

/**
 * The aggregator's supervisor handle, for status and restart surfaces. The
 * `globalThis` slot behind it lives in `./mcp-http-handle`, a leaf, so readers
 * that must not load the boot graph can reach it without this module.
 */
export function getMcpHttpChild(): McpHttpChildHandle | null {
  return getMcpHttp();
}

/**
 * Test-only escape hatch: write a fake handle to the same `globalThis` slot
 * `defaultCategoryBDeps.startMcpHttp` writes to, so a test can exercise the
 * dual-instance property (a SEPARATE dynamic import of this module, via
 * `vi.resetModules()`, still sees the handle through `getMcpHttpChild()`)
 * without spinning up a real aggregator child.
 */
export function setMcpHttpChildForTests(handle: McpHttpChildHandle | null): void {
  setMcpHttp(handle);
}

/** How long a signal-triggered shutdown waits on the export driver before
 *  exiting anyway. Ctrl-C must stay responsive even with Chromium wedged. */
const SHUTDOWN_DRIVER_TIMEOUT_MS = 3000;

/**
 * The port this process publishes in `<LIBI_HOME>/port`. Lives in
 * `lib/libi-home.ts`, beside `getCurrentPort()` that reads it back, so the
 * aggregator supervisor can hand the same value to its child without importing
 * the boot graph; re-exported here where it has always been imported from.
 */
export { resolvePortToPublish };

export function writePortFileAndInstallSignals(): void {
  const { port, source } = resolvePortToPublish();
  // This process IS the server listening on `port`. Everything in it that asks
  // `getCurrentPort()` (the tracking route's and runner's own-port check, the
  // export and tracking renders, the terminal WebSocket), and every child it
  // spawns, must resolve this server, not whichever libi on the home wrote
  // `<LIBI_HOME>/port` last; its aggregator child already does. The
  // environment rather than a module variable, because Turbopack can load this
  // graph more than once in one process and every copy shares `process.env`.
  // The in-app terminal strips it again (`lib/terminal/manager.ts`).
  process.env[LIBI_SERVER_PORT_ENV] = port;
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
    // Only while the file still names OUR port. Another libi on the same home
    // (a second desktop launch, say) may have published its own since, and
    // deleting that leaves its MCP children with no server to find.
    removePortFileIfOwned(portFile, port);
    // Best-effort on the synchronous `exit` path, where nothing can be awaited:
    // stop the aggregator so nothing outlives the server holding a port nobody
    // is listening on. Its `stop()` removes `mcp-port` before its first await,
    // so the file goes here too, and only while that supervisor still owns it.
    const c = getMcpHttp();
    if (c) {
      try { void c.stop(); } catch { /* ignore */ }
    }
  };
  const cleanupSignal = async () => {
    // Retire every agent process before anything else runs, so their SIGINT/
    // SIGTERM exits are recognized as part of our own shutdown and never
    // reported as crashes in an open chat. This has to be the very first
    // statement, synchronous and unconditional, so it lands before the
    // `shuttingDown` check and before any `await` below. If it threw, a bare
    // call here would reject this async handler before `shuttingDown` is set
    // and before `process.exit` runs, leaving Ctrl-C disarmed — so a throw is
    // swallowed and the shutdown below still proceeds unconditionally.
    try {
      getProcessManager().retireAllForExit();
    } catch {
      // Swallow: the exit below must still run no matter what happened here.
    }
    // The same stop routinely arrives more than once: a signal sent to a whole
    // process group also reaches this process through bin/libi.js passing it
    // on, and `next dev` relays what it gets to its server. Every repeat must
    // land here and change nothing.
    if (shuttingDown) return;
    shuttingDown = true;
    // Two independent shutdowns: `pickDriver().shutdown()` closes the EXPORT
    // driver (Chromium), and `mcpHttp.stop()` stops the aggregator child
    // (which removes `mcp-port` itself — it has to happen before the port
    // files go, or a child left running keeps its port bound past our exit).
    // Neither may make Ctrl-C stop working, so they run CONCURRENTLY inside
    // ONE deadline: in series a wedged browser spent the whole driver timeout
    // and only THEN started the aggregator's 2s SIGTERM grace.
    try {
      await Promise.race([
        Promise.all([
          Promise.resolve()
            .then(() => pickDriver().shutdown())
            .catch((err: unknown) => serverLogger.warn({ err }, "driver shutdown failed during exit")),
          Promise.resolve()
            .then(() => getMcpHttp()?.stop())
            .catch((err: unknown) =>
              serverLogger.warn(
                { tag: "mcp-http", op: "stop_failed", err },
                "aggregator shutdown failed during exit",
              ),
            ),
        ]),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRIVER_TIMEOUT_MS).unref()),
      ]);
    } catch (err) {
      serverLogger.warn({ err }, "shutdown failed during exit");
    }
    setMcpHttp(null);
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
  for (const signal of shutdownSignals()) process.on(signal, cleanupSignal);
  process.on("exit", cleanupPortFile);
}

/**
 * The signals that run the orderly shutdown, for the host this server runs in.
 *
 * SIGHUP is how a closed terminal says stop. On POSIX it goes to the
 * terminal's foreground job. On Windows, Node reports a console window being
 * closed as SIGHUP, and Windows ends the process a few seconds later whatever
 * the handler is doing, which the shutdown's 3 s bound fits inside. Without a
 * listener, Node's default ends the process on the spot: the MCP endpoint is
 * never stopped and both port files are left behind.
 *
 * Windows delivers that close to the console's processes one at a time, newest
 * first, waiting up to ~5 s on each handler before moving on. The server's
 * children are newer than the server, so they are gone before this handler
 * runs, and a child that listens for SIGHUP itself holds the server's turn back
 * by those ~5 s. That is why the MCP endpoint takes the default and ends at
 * once, and why its supervisor reads that exit as a closed console, not a crash.
 *
 * Not inside Electron's main process, where the packaged app runs this server.
 * Electron quits the app on SIGHUP by itself (`before-quit`, `will-quit`,
 * Chromium's own teardown, then this module's `exit` cleanup), and a Node
 * listener added after `ready`, which is when this runs there, replaces that
 * quit outright. The app is only ever a terminal's job when someone starts its
 * binary from a shell.
 */
export function shutdownSignals(
  versions: NodeJS.ProcessVersions = process.versions,
): NodeJS.Signals[] {
  return versions.electron ? ["SIGTERM", "SIGINT"] : ["SIGTERM", "SIGINT", "SIGHUP"];
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
  startMcpHttp: () => Promise<void>;
  prepareAgentDir: (dir: string) => Promise<void>;
  warmAgentProcess: (agentId: string) => Promise<void>;
  loadSessions: (agentId: string) => Promise<void>;
  probeAndPersist: () => Promise<void>;
  createStandby: () => Promise<void>;
  syncSkillInstalls: () => Promise<void>;
}

export const defaultCategoryBDeps: CategoryBDeps = {
  migrateDatabase: () => {
    ensureLibiDirs();
    migrateDatabaseImpl();
    reseedCrashReportGate();
  },
  // `process.uptime()` gives the moment THIS process started, not the moment this
  // lifecycle step happens to run (category A can take a while) — the cutoff
  // recoverOrphanedJobs needs to avoid sweeping a queued row this same process just
  // enqueued while an earlier boot step was still running.
  //
  // It's an estimate, not a true clock read: an NTP correction between the real
  // process start and this call could push it later. That's still safe — nothing
  // can enqueue a job before Next starts serving requests, which is strictly
  // after this boot step runs, so a cutoff that lands slightly late still
  // precedes every enqueue this process makes.
  recoverOrphanedJobs: () => recoverOrphanedJobsImpl(Date.now() - process.uptime() * 1000),
  writePortFile: writePortFileAndInstallSignals,
  startMcpHttp: async () => {
    const handle = await startMcpHttpChild({
      // The aggregator can move ports when another instance took ours
      // (see `repickIfTaken`). Every built MCP config carries the URL, so
      // drop the caches — new ACP sessions must get the port we ended on.
      onPortChanged: () => invalidateMcpConfig({ reason: "mcp-port-changed" }),
      // Stored the moment the first child exists, not when this resolves up to
      // 30 s later: quitting libi inside that window runs the shutdown hooks
      // above, and they can only stop a child whose handle they can find.
      onHandle: setMcpHttp,
    });
    // Stored whatever state it came up in. A first launch that never answered
    // resolves `gave-up` (the supervisor has logged why, with the child's own
    // output). Holding that handle is what lets `/api/mcp/health` report it
    // and `/api/mcp/restart` recover it without restarting libi. Not a fatal
    // boot error: the studio and its agents are still worth having without
    // libi's tools, and the libi MCP tab shows the state with a Restart button.
    setMcpHttp(handle);
    if (handle.status() === "gave-up") {
      serverLogger.error(
        { tag: "mcp-http", phase: "category-b", op: "boot_start_gave_up", port: handle.port },
        "libi's MCP endpoint did not come up at boot; the studio keeps booting without libi's tools. Restart it from the Libi MCP tab.",
      );
      // The log is for a report. This is for the user, who is watching the
      // splash or the terminal while libi starts and would otherwise meet a
      // chat with no libi tools and nothing saying why.
      lifecycleEvents.emit({
        kind: "warning",
        phase: "category-b",
        step: "mcp-http",
        message: MCP_TOOLS_UNAVAILABLE_WARNING,
      });
    }
  },
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
    // already system-installed (e.g. the uv-only deps on whisper /
    // local-tts / local-music) keep their seed `installStatus = "pending"`
    // forever, and the UI shows them as "Checking…" indefinitely.
    await dm.settleAllBundledStatuses();
    // Pre-warm tier-1 only. With no tier-1 MCP left this warms nothing, which
    // is the point: the un-tiered call spawned `npx -y @kevinwatt/yt-dlp-mcp`
    // on EVERY boot (1.5-2 s warm, minutes cold, a hard failure offline)
    // because youtube-downloader's uv + yt-dlp deps were tier-1-flagged and
    // therefore settled "installed". Keep the argument even when the set is
    // empty — it is the thing that stops the next tier-1 addition from
    // silently reintroducing the sweep.
    await dm.prewarmBundledMcps({ tier: "tier-1" });
  },
  createStandby: async () => {
    await getSessionManager().createStandbySession();
  },
  syncSkillInstalls: () => syncSkillInstalls("boot"),
};

const FIXED_STEPS: Array<{
  id: CategoryBStepId;
  run: (deps: CategoryBDeps) => Promise<void> | void;
  hint: string;
}> = [
  {
    id: "db-migrate",
    run: (d) => d.migrateDatabase(),
    // NOT `rm -rf ~/.libi/libi.sqlite*`, which this hint used to say. It is the
    // first thing a stuck user runs, it is irreversible, and it is wrong for
    // every cause this step actually has: a locked file, a half-written WAL, a
    // disk that filled mid-migration, and — the one that made this a defect —
    // an older libi meeting a newer schema, where the data is not damaged at
    // all and deleting it is the only way to lose it. (That case now throws
    // `DatabaseSchemaTooNewError` before this step can fail, and brings its own
    // hint.) What is left is diagnosable and, if the user must start clean,
    // reversible: MOVE the files, never delete them. libi's own pre-migration
    // copies (`libi.sqlite.backup-*`, `backupDb` in lib/db/client.ts) are named
    // here because a user who has already deleted something needs to know they
    // exist.
    hint: [
      "Database migration failed. Nothing was deleted, and libi copies the database",
      "before every migration — look for `libi.sqlite.backup-*` next to it in ~/.libi.",
      "The SQLite error is in ~/.libi/logs/libi.log (tag `db`); include that line in a report.",
      "If you must start clean, MOVE the files aside rather than deleting them, so they",
      "can be restored: `mkdir ~/libi-db-aside && mv ~/.libi/libi.sqlite* ~/libi-db-aside/`",
    ].join("\n"),
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
  {
    id: "mcp-http",
    run: (d) => d.startMcpHttp(),
    // Reached only when no launch could be attempted at all: a child that
    // starts and never answers ends gave-up and boot carries on. What is left is
    // an entry point that does not resolve or a port picker that threw, which
    // is a damaged install, not a busy port.
    hint: "libi could not launch its MCP endpoint (libi serve-mcp-http) at all, which points at a damaged install rather than a busy port. The cause is in ~/.libi/logs/libi.log (tag `mcp-http`); reinstalling libi fixes a damaged install.",
  },
];

/**
 * A hint carried by the error itself, or null to use the step's generic one.
 *
 * Structural, not `instanceof`: the migration runs in whichever module graph
 * the caller loaded (Next server, Electron main, a test), and an identity check
 * across two copies of `lib/db/client.ts` would silently fall through to the
 * generic hint — which is the one case where the generic hint is wrong.
 */
function hintForError(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const hint = (err as Error & { hint?: unknown }).hint;
  return typeof hint === "string" && hint.length > 0 ? hint : null;
}

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
      // A step's `hint` is the generic one for that step. An error that knows
      // better — `DatabaseSchemaTooNewError`, where the step's own advice would
      // be actively harmful — carries its own and wins.
      throw new BootPhaseError(s.id, message, hintForError(err) ?? s.hint);
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
  // Reclaim staged runtimes the loader can never select again. A shell update
  // raises the bundled version underneath anything staged, and since the A0b
  // fix selection is by version — so a staged runtime at or below bundled is
  // unreachable forever. ~1.3 GB each, and keep-2 cannot catch a user with
  // exactly one stale one. Fire-and-forget and non-fatal, like the sweeps
  // below: housekeeping must never block or fail boot.
  void (async () => {
    try {
      const { pruneRuntimesBelowBundled, runningRuntimePrefix } = await import(
        "@/lib/runtime/runtime-prune"
      );
      const { describeCurrentRuntime } = await import("@/lib/runtime/current-runtime");
      const current = describeCurrentRuntime();
      if (!current.updatesSupported || !current.bundledVersion) return;
      const { removed } = pruneRuntimesBelowBundled({
        bundledVersion: current.bundledVersion,
        protectPrefix: runningRuntimePrefix(),
      });
      if (removed.length > 0) {
        serverLogger.info(
          { tag: "lifecycle", op: "pruned_unreachable_runtimes", count: removed.length },
          "reclaimed staged runtimes the loader can never select again",
        );
      }
    } catch (err) {
      serverLogger.warn(
        { tag: "lifecycle", op: "prune_unreachable_runtimes_failed", err },
        "could not prune unreachable staged runtimes",
      );
    }
  })();

  // Reclaim disk libi allocated and no longer needs: superseded Playwright
  // browser revisions (1.6 GB across three, measured 2026-09-08) and the 572 MB
  // MobileCLIP encoder the tracking installer downloads only to export
  // yoloe11.onnx. Fire-and-forget and non-fatal, like every sweep above it —
  // housekeeping must never block or fail boot.
  void (async () => {
    try {
      const { runBootHousekeeping } = await import("./housekeeping");
      await runBootHousekeeping();
    } catch (err) {
      serverLogger.warn(
        { tag: "lifecycle", op: "prune", err },
        "boot housekeeping threw; nothing was reclaimed",
      );
    }
  })();

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

  // Phase 1e: delete the agent engines older versions downloaded into
  // ~/.libi/agents — the chat runs the user's own CLI now. Idempotent and
  // non-fatal; logs bytes freed under tag agent-install, op engine_cleanup.
  try {
    const { cleanupEnginePackages } = await import("@/lib/agents/engine-cleanup");
    cleanupEnginePackages();
  } catch (err) {
    serverLogger.warn(
      { tag: "agent-install", op: "engine_cleanup_phase_failed", err },
      "Engine cleanup threw; continuing boot",
    );
  }

  // Phase 2: prepare the in-app agent dir (skills + version). Strip the
  // instruction/MCP files older versions wrote there — the adapter also reads
  // a workspace .mcp.json, so a stale one would register libi twice. Non-fatal:
  // an unremovable legacy file must never block boot.
  try {
    stripLegacyAgentDirFiles(getLibiAgentDir());
  } catch (err) {
    serverLogger.warn(
      { tag: "lifecycle", phase: "category-b", op: "legacy_agent_dir_strip_failed", err },
      "Legacy agent-dir strip threw; continuing boot",
    );
  }
  await deps.prepareAgentDir(getLibiAgentDir());

  // The user's own agents' skill copies are rewritten in the background: boot
  // does not await this sync, and a recorded folder that is missing is skipped
  // after one existence check. The writes themselves are synchronous
  // filesystem calls, so they still run on the event loop after boot moves on.
  void deps.syncSkillInstalls().catch((err) => {
    serverLogger.warn(
      { tag: "skills", phase: "category-b", op: "installs_sync_at_boot_failed", err: sanitizeErrForLog(err) },
      "Skill-install sync at boot failed; continuing",
    );
  });

  // Phase 3: agent-dependent steps. Skipped if there is no preferred agent, its
  // adapter isn't installed, or the user's CLI for it doesn't resolve — the
  // Agents tab is where the user fixes either, so boot doesn't fail on it.
  const preferredAgent = getSettings().preferredAgent;
  if (
    !preferredAgent ||
    !getAgentConfig(preferredAgent)?.installed ||
    (isSetupAgentId(preferredAgent) && !isUsableCli(await resolveAgentCli(preferredAgent)))
  ) {
    lifecycleEvents.emit({ kind: "category-b-done", durationMs: Date.now() - start });
    return;
  }

  const agentName = getAgentSetup(preferredAgent)?.name ?? preferredAgent;
  lifecycleEvents.emit({ kind: "category-b-step", step: "agent-warm", status: "running" });
  try {
    await deps.warmAgentProcess(preferredAgent);
    await deps.loadSessions(preferredAgent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // An agent that came up and answered `-32000 Authentication required` is
    // installed; it needs a sign-in, which the Agents tab walks the user through.
    // Anything else is also diagnosed there, on the agent's row.
    throw new BootPhaseError(
      "agent-warm",
      message,
      isAuthRequiredError(err)
        ? `${agentName} started but isn't signed in. Open Agents → ${agentName} to sign in.`
        : "Failed to warm the agent subprocess. Open Agents and check the agent's row.",
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
  // read the freshest config.
  invalidateMcpConfig({ reason: "category-b-ready" });

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
