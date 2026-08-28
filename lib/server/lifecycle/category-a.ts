/**
 * Category A — "Everything installed and verified."
 *
 * Runs in the CLI parent process (or Electron main process) BEFORE the
 * Next.js child is spawned. Blocks startup until every bundled MCP's
 * npm package + binary dependencies are on disk and an in-memory probe
 * has confirmed the server completes its initialize handshake.
 *
 * Emits per-item lifecycle events so the CLI adapter can render `ora`
 * spinners and the Electron splash can render its progress UI. On any
 * step failure, throws a structured InstallPhaseError which `runner.ts`
 * converts into a fatal lifecycle event; the CLI exits with `process.exit(1)`.
 *
 * Hot path: filesystem version checks; ~50 ms.
 * Cold path: 1–3 min dominated by playwright-chromium (~150 MB).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { ensureBundledNpmMcps } from "@/lib/mcp/bundled-install";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import { probeMcpInMemory } from "@/mcp/registry/server-prober";
import { ensureLibiDirs } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";
import { ensureClaudeAdapterInstalled, type EnsureAdapterResult } from "@/lib/agents/runtime-install";
import {
  ensureNodeRuntime,
  type NodeRuntimeOutcome,
  type NodeRuntimeProgress,
} from "@/lib/runtime/node-runtime";
import { lifecycleEvents } from "./events";
import { binaryInstallHints } from "./install-error-hints";
import type { BundledMcpDef } from "@/mcp/registry/types";
import type { InstallItem } from "./types";

/**
 * Tier-1 defs are the only ones installed wholesale during Category A's
 * blocking startup phase. Tier-2 MCPs (yt-dlp-mcp, elevenlabs, fal-ai)
 * are installed by the agent on demand via the libi install tools —
 * their `installFlow` is explicitly "tier-2" in `mcp/registry/bundled.ts`.
 * Everything else (the core "libi" entry and any future addition without
 * an explicit flag) defaults to tier-1. In test mode, fal-ai's transport
 * is swapped to fake-fal (mcp/dev/fake-fal/) at runtime — no extra def.
 *
 * Individual deps on a tier-2 def may still flag themselves tier-1
 * (e.g. yt-dlp under youtube-downloader) — those are handled separately
 * in `defs()` below by emitting a synthetic def carrying only the
 * tier-1 dep so Category A's progress UI still labels the install.
 */
const TIER1_DEFS = BUNDLED_MCP_SERVERS.filter(
  (def) => (def.installFlow ?? "tier-1") === "tier-1",
);

/** Thrown by Category A steps; carries an actionable hint for the user. */
export class InstallPhaseError extends Error {
  constructor(
    public step: string,
    message: string,
    public hint: string,
  ) {
    super(message);
    this.name = "InstallPhaseError";
  }
}

export interface CategoryADeps {
  ensureBundledNpm: () => Promise<void>;
  installBinaryDeps: () => Promise<void>;
  probeMcp: (
    def: BundledMcpDef,
  ) => Promise<{ status: "up" | "down"; error: string | null; durationMs: number }>;
  defs: () => BundledMcpDef[];
  /**
   * Installs the Claude Code ACP adapter (`lib/agents/runtime-install.ts`).
   * NEVER throws — failure is reported via `EnsureAdapterResult.error`, not
   * an exception. This phase is intentionally non-fatal: Codex- and
   * Terminal-only users must boot fine even when this fails, so
   * `runCategoryA` never converts its outcome into an `InstallPhaseError`.
   */
  ensureClaudeAdapter: () => Promise<EnsureAdapterResult>;
  /**
   * Guarantees a spawnable Node.js runtime at `<LIBI_HOME>/bin/node`
   * (`lib/runtime/node-runtime.ts`). NEVER throws — failure is reported via
   * the returned outcome, and this phase is non-fatal for the same reason
   * `ensureClaudeAdapter` is. `onProgress` lets the caller mirror the same
   * install-start/-progress/-done `lifecycleEvents` sequence every other
   * phase emits (I2 — a silent multi-second download read as a hang).
   */
  ensureNodeRuntime: (onProgress?: (p: NodeRuntimeProgress) => void) => Promise<NodeRuntimeOutcome>;
}

export const defaultCategoryADeps: CategoryADeps = {
  ensureBundledNpm: () =>
    ensureBundledNpmMcps((p) => {
      if (p.phase === "installing" && p.current) {
        const def = TIER1_DEFS.find((d) => d.id === p.current);
        if (def) {
          lifecycleEvents.emit({
            kind: "category-a-install-start",
            item: { id: def.id, label: def.name, kind: "npm" },
          });
        }
      }
    }),
  installBinaryDeps: async () => {
    const dm = new DependencyManager();
    // Category A runs BEFORE DB migrations (Category B owns those).
    // Tell the DM to keep its hands off the DB while installing — every
    // row it would write is recomputed from disk by
    // `settleAllBundledStatuses()` during Category B's `probeAndPersist`
    // step, so the eventual DB state is identical.
    dm.setSkipDbWrites(true);
    const started = new Set<string>();
    await dm.installBundledDeps({
      tier: "tier-1",
      onProgress: (p) => {
        const item = { id: p.binary, label: p.binary, kind: "binary" as const };
        if (!started.has(p.binary)) {
          started.add(p.binary);
          lifecycleEvents.emit({ kind: "category-a-install-start", item });
        }
        if (p.status === "downloading" || p.status === "extracting") {
          lifecycleEvents.emit({
            kind: "category-a-install-progress",
            item,
            bytesDownloaded: p.bytesDownloaded ?? 0,
            bytesTotal: p.bytesTotal ?? null,
            // Carries retry visibility ("download stalled — retrying (2 of
            // 3)") to the CLI spinner + Electron splash, both of which
            // already prefer `detail` over the byte counts.
            detail: p.detail,
          });
        } else if (p.status === "skipped") {
          lifecycleEvents.emit({
            kind: "category-a-install-done",
            item,
            result: "skipped",
            reason: p.reason ?? "already installed",
          });
        } else if (p.status === "done") {
          lifecycleEvents.emit({
            kind: "category-a-install-done",
            item,
            result: "installed",
          });
        }
      },
    });
  },
  probeMcp: probeMcpInMemory,
  defs: () => TIER1_DEFS,
  ensureClaudeAdapter: () => ensureClaudeAdapterInstalled(),
  ensureNodeRuntime: (onProgress) => ensureNodeRuntime(undefined, onProgress),
};

const CLAUDE_ADAPTER_ITEM: InstallItem = {
  id: "claude-adapter",
  label: "Claude Code adapter",
  kind: "npm",
};

const NODE_RUNTIME_ITEM: InstallItem = {
  id: "node-runtime",
  label: "Node.js runtime",
  kind: "binary",
};

/**
 * Hard cap on the WHOLE node-runtime phase (I2). Generous margin over
 * `NODE_DOWNLOAD_FETCH_TIMEOUT_MS` (60s) + the download's own `tar` timeout
 * (120s) so a real slow-but-progressing download is never falsely killed,
 * while still bounding a hang this phase's own timeouts fail to catch (e.g.
 * a DNS resolution stuck before `fetch()`'s AbortSignal can even start
 * counting). This phase is non-fatal either way — a timeout here degrades
 * to the same `resolveNodeCommand()` bare-`"node"` fallback as any other
 * failure, it just stops boot from waiting past this point.
 */
export const NODE_RUNTIME_PHASE_TIMEOUT_MS = 240_000;

/** Human-readable status line for one node-runtime progress tick. Pure so the
 *  copy is testable, mirroring `claudeAdapterProgressDetail` above. */
export function nodeRuntimeProgressDetail(p: NodeRuntimeProgress): string {
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)}MB`;
  switch (p.phase) {
    case "linking":
      return "linking a Node.js install already on this machine";
    case "downloading": {
      const downloaded = mb(p.bytesDownloaded ?? 0);
      return p.bytesTotal
        ? `downloading Node.js runtime — ${downloaded} / ${mb(p.bytesTotal)}`
        : `downloading Node.js runtime — ${downloaded}`;
    }
    case "extracting":
      return "extracting Node.js runtime archive";
    case "installing":
      return "installing Node.js runtime";
  }
}

/** Reject after `ms` if `p` hasn't settled — `p` itself keeps running (there
 *  is no cross-runtime way to cancel an arbitrary Promise), but the caller
 *  stops waiting on it, which is all a boot-blocking phase needs. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** How often the adapter phase emits an elapsed-time tick while npm runs. */
export const CLAUDE_ADAPTER_TICK_MS = 2000;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Status line for one adapter-install tick. Pure so the copy is testable.
 *
 * States the size and the once-only nature because both are the difference
 * between "this is working" and "this is hung": ~345MB on a slow link is
 * minutes of silence, and a user who believes it happens every boot will kill
 * it. Force-quitting mid-download is exactly what leaves the half-installed
 * tree behind (npm exits 0 on a failed optionalDependency), so this copy is
 * load-bearing, not decoration.
 */
export function claudeAdapterProgressDetail(elapsedMs: number): string {
  return `downloading ~345 MB, first run only — ${formatElapsed(elapsedMs)} elapsed`;
}

/**
 * Emit an immediate tick, then one every `CLAUDE_ADAPTER_TICK_MS`, until the
 * returned stop function is called. The first tick is synchronous so the UI
 * never renders a bare "running" state even for an install that finishes fast.
 */
function startClaudeAdapterTicker(): () => void {
  const startedAt = Date.now();
  const tick = () =>
    lifecycleEvents.emit({
      kind: "category-a-install-progress",
      item: CLAUDE_ADAPTER_ITEM,
      bytesDownloaded: 0,
      bytesTotal: null,
      detail: claudeAdapterProgressDetail(Date.now() - startedAt),
    });
  tick();
  const timer = setInterval(tick, CLAUDE_ADAPTER_TICK_MS);
  // Never hold the process open on this timer — the phase's own finally
  // clears it, but a throw between here and there must not wedge exit.
  timer.unref?.();
  return () => clearInterval(timer);
}

// Sync-log helper: when Category A hangs in a packaged Electron, pino's
// worker-thread transport doesn't reliably flush before the crash. This
// writes to a sync file so we always see exactly which step ran last.
function syncLog(line: string): void {
  try {
    const logDir = path.join(
      process.env.LIBI_HOME ?? path.join(os.homedir(), ".libi"),
      "logs",
    );
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, "category-a-sync.log"),
      `[${new Date().toISOString()}] ${line}\n`,
    );
  } catch {
    /* never throw from a logger */
  }
}

export async function runCategoryA(
  deps: CategoryADeps = defaultCategoryADeps,
): Promise<void> {
  const start = Date.now();
  syncLog("runCategoryA: begin");
  ensureLibiDirs();
  syncLog("runCategoryA: ensureLibiDirs done");

  // Category A is filesystem-only by contract. Category B (running in
  // the Next.js child) owns DB migrations and row state. The
  // DependencyManager is configured with `skipDbWrites=true` so its
  // install path never touches the schema before migrations land.

  // Phase 1: npm install
  logger.info(
    { tag: "lifecycle", phase: "category-a", op: "npm_install_start" },
    "Installing bundled MCP npm packages",
  );
  syncLog("phase 1: calling ensureBundledNpm");
  try {
    await deps.ensureBundledNpm();
    syncLog("phase 1: ensureBundledNpm done");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    syncLog(`phase 1 FAIL: ${message}`);
    throw new InstallPhaseError(
      "npm-install",
      `Failed to install bundled MCP npm packages: ${message}`,
      [
        "Common causes:",
        "  1. No network connection to registry.npmjs.org",
        "  2. Corporate proxy blocking npm — set npm_config_proxy",
        "  3. Stale install lock — delete ~/.libi/.bundled-install.lock and retry",
        "",
        "Then run libi again.",
      ].join("\n"),
    );
  }

  // Phase 1.75: a Node.js runtime libi can spawn — NEVER fatal.
  //
  // RUNS BEFORE THE BINARY DEPS, deliberately. `playwright-chromium` (and any
  // other custom installer that shells out to a Node program) resolves its
  // interpreter through `resolveNodeCommand()`, which returns bare `"node"`
  // until this phase has put one at `<LIBI_HOME>/bin/node`. On a machine whose
  // only node lives in a version manager — the common macOS case — a
  // Finder-launched .app has no node on PATH, so Chromium's install failed on
  // the first boot and only succeeded on the second, once this phase had run.
  // It self-healed, which is why this is minor rather than a blocker, but the
  // ordering was simply backwards.
  //
  // The libi MCP and the Claude ACP adapter are both spawned as Node programs
  // by processes libi does not own, so they need a real `node` executable —
  // and a Finder-launched .app has a PATH with no version manager in it. See
  // `lib/runtime/node-runtime.ts` for the full story (including why
  // `process.execPath` and `utilityProcess.fork()` are both unavailable here).
  //
  // Non-fatal for the same reason as the adapter phase below: a machine
  // without node still boots into a working Terminal surface, and
  // `resolveNodeCommand()` degrades to bare `"node"` — exactly the behaviour
  // that shipped before this phase existed.
  //
  // Emits the same install-start/-progress/-done `lifecycleEvents` sequence
  // every other Category A phase does (I2) — without it, the splash/CLI
  // spinner sat motionless on the PREVIOUS step's label for the whole
  // download with no indication anything was happening, indistinguishable
  // from a hang. `withTimeout` bounds the phase overall so a stall this
  // phase's own internal timeouts miss still can't wedge boot.
  logger.info(
    { tag: "lifecycle", phase: "category-a", op: "node_runtime_start" },
    "Ensuring a spawnable Node.js runtime",
  );
  syncLog("phase 1.75: calling ensureNodeRuntime");
  lifecycleEvents.emit({ kind: "category-a-install-start", item: NODE_RUNTIME_ITEM });
  try {
    const nodeResult = await withTimeout(
      deps.ensureNodeRuntime((p) => {
        lifecycleEvents.emit({
          kind: "category-a-install-progress",
          item: NODE_RUNTIME_ITEM,
          bytesDownloaded: p.bytesDownloaded ?? 0,
          bytesTotal: p.bytesTotal ?? null,
          detail: nodeRuntimeProgressDetail(p),
        });
      }),
      NODE_RUNTIME_PHASE_TIMEOUT_MS,
      `node runtime phase exceeded ${NODE_RUNTIME_PHASE_TIMEOUT_MS}ms`,
    );
    if (nodeResult.ok) {
      const alreadyManaged = nodeResult.source === "already-managed";
      logger.info(
        {
          tag: "lifecycle",
          phase: "category-a",
          op: "node_runtime_ready",
          source: nodeResult.source,
          binPath: nodeResult.path,
        },
        `Node.js runtime ready (${nodeResult.source})`,
      );
      syncLog(`phase 2.25: node runtime ${nodeResult.source} at ${nodeResult.path}`);
      lifecycleEvents.emit({
        kind: "category-a-install-done",
        item: NODE_RUNTIME_ITEM,
        result: alreadyManaged ? "skipped" : "installed",
        reason: alreadyManaged ? "already installed" : undefined,
      });
    } else {
      logger.warn(
        { tag: "lifecycle", phase: "category-a", op: "node_runtime_failed", err: nodeResult.error },
        "Could not provision a Node.js runtime — the libi MCP and Claude adapter will fall back to `node` on PATH",
      );
      syncLog(`phase 2.25: node runtime FAILED: ${nodeResult.error}`);
      lifecycleEvents.emit({
        kind: "category-a-install-done",
        item: NODE_RUNTIME_ITEM,
        result: "failed",
        reason: nodeResult.error,
      });
    }
  } catch (err) {
    // ensureNodeRuntime() is documented never to throw; the timeout above IS
    // expected to reject on a stall. Either way this phase never aborts boot.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { tag: "lifecycle", phase: "category-a", op: "node_runtime_failed", err: message },
      "Node.js runtime phase threw (continuing)",
    );
    syncLog(`phase 2.25: node runtime THREW: ${message}`);
    lifecycleEvents.emit({
      kind: "category-a-install-done",
      item: NODE_RUNTIME_ITEM,
      result: "failed",
      reason: message,
    });
  }

  // Phase 2: binary deps
  logger.info(
    { tag: "lifecycle", phase: "category-a", op: "binary_install_start" },
    "Installing bundled binary deps",
  );
  syncLog("phase 2: calling installBinaryDeps");
  try {
    await deps.installBinaryDeps();
    syncLog("phase 2: installBinaryDeps done");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InstallPhaseError(
      "binary-install",
      `Failed to install bundled binary deps: ${message}`,
      binaryInstallHints(message),
    );
  }

  // Phase 2.5: Claude Code adapter — NEVER fatal.
  //
  // Claude Code is libi's default agent, so a user whose default agent is
  // silently absent is a worse outcome than a slower first boot (the same
  // reasoning that already blocks Phase 2 on ~150MB of Chromium). But unlike
  // every other Category A item, Codex and Terminal are fully functional
  // without this one, so a transient npm hiccup here must never brick a
  // Codex/Terminal-only user's app the way an InstallPhaseError would (it
  // exits the CLI with code 1). ensureClaudeAdapterInstalled() is documented
  // to never throw; the try/catch below is defense in depth for a phase
  // whose entire purpose is "never abort boot" — it still only logs and
  // reports, it never rethrows or constructs an InstallPhaseError.
  logger.info(
    { tag: "lifecycle", phase: "category-a", op: "claude_adapter_start" },
    "Installing the Claude Code adapter",
  );
  syncLog("phase 2.5: calling ensureClaudeAdapter");
  lifecycleEvents.emit({ kind: "category-a-install-start", item: CLAUDE_ADAPTER_ITEM });
  const stopAdapterTicker = startClaudeAdapterTicker();
  try {
    const result = await deps.ensureClaudeAdapter();
    if (result.installed && result.upgradeError) {
      // Usable, but NOT the version we set out to install: the upgrade failed
      // and the user keeps the adapter they already had (see
      // `EnsureAdapterResult.upgradeError`). Logging `claude_adapter_ready`
      // here would make a pin bump that reached nobody look identical in
      // ~/.libi/logs/libi.log to one that reached everybody — the whole
      // reason this branch exists.
      //
      // "skipped", not "failed": the adapter runs, so the boot UI must not
      // warn a user whose Claude Code is working. Nothing here throws, so
      // Phase 2.5 stays non-fatal exactly as before.
      logger.warn(
        {
          tag: "lifecycle",
          phase: "category-a",
          op: "claude_adapter_stale_kept",
          binPath: result.binPath,
          staleVersion: result.staleVersion,
          error: result.upgradeError,
        },
        "Claude Code adapter upgrade failed — keeping the installed version",
      );
      lifecycleEvents.emit({
        kind: "category-a-install-done",
        item: CLAUDE_ADAPTER_ITEM,
        result: "skipped",
        reason: `kept ${result.staleVersion ?? "the installed version"} — upgrade failed`,
      });
    } else if (result.installed) {
      logger.info(
        { tag: "lifecycle", phase: "category-a", op: "claude_adapter_ready", binPath: result.binPath },
        "Claude Code adapter ready",
      );
      lifecycleEvents.emit({
        kind: "category-a-install-done",
        item: CLAUDE_ADAPTER_ITEM,
        result: "installed",
      });
    } else {
      logger.warn(
        {
          tag: "lifecycle",
          phase: "category-a",
          op: "claude_adapter_failed",
          error: result.error,
        },
        "Claude Code adapter install failed — Codex and Terminal remain available",
      );
      lifecycleEvents.emit({
        kind: "category-a-install-done",
        item: CLAUDE_ADAPTER_ITEM,
        result: "failed",
        reason: result.error ?? "unknown error",
      });
    }
    syncLog(
      `phase 2.5: ensureClaudeAdapter done (installed=${result.installed}` +
        `${result.upgradeError ? ", upgrade failed — kept the installed version" : ""})`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    syncLog(`phase 2.5: ensureClaudeAdapter threw unexpectedly: ${message}`);
    logger.warn(
      { tag: "lifecycle", phase: "category-a", op: "claude_adapter_threw", err },
      "Claude Code adapter install threw unexpectedly — Codex and Terminal remain available",
    );
    lifecycleEvents.emit({
      kind: "category-a-install-done",
      item: CLAUDE_ADAPTER_ITEM,
      result: "failed",
      reason: message,
    });
  } finally {
    stopAdapterTicker();
  }

  // Phase 3: in-memory probe of each spawn-ready MCP.
  // Skip core (libi itself), HTTP MCPs, and MCPs gated on user config.
  // Their binary deps were still installed in Phase 2 (so when the user
  // configures elevenlabs etc. later, uv is already present).
  syncLog("phase 3: probing MCPs");
  for (const def of deps.defs()) {
    if (def.core) continue;
    if (def.type === "http") continue;
    if (def.requiredEnvVars && def.requiredEnvVars.length > 0) {
      lifecycleEvents.emit({
        kind: "category-a-probe-done",
        mcpId: def.id,
        label: def.name,
        status: "skipped",
        reason: "needs_config",
        durationMs: 0,
      });
      continue;
    }

    syncLog(`phase 3: probing ${def.id}`);
    lifecycleEvents.emit({
      kind: "category-a-probe-start",
      mcpId: def.id,
      label: def.name,
    });
    const result = await deps.probeMcp(def);
    syncLog(`phase 3: probed ${def.id} → ${result.status}`);
    lifecycleEvents.emit({
      kind: "category-a-probe-done",
      mcpId: def.id,
      label: def.name,
      status: result.status,
      durationMs: result.durationMs,
    });

    if (result.status === "down") {
      throw new InstallPhaseError(
        `probe:${def.id}`,
        `MCP server "${def.name}" failed to start: ${result.error ?? "unknown"}`,
        [
          "Common causes:",
          "  1. Bundled install corrupted — delete ~/.libi/node_modules and retry",
          "  2. Missing binary dep — check ~/.libi/bin/ exists and is on PATH",
          "  3. Upstream bug in the MCP package",
          "",
          `Run \`tail ~/.libi/logs/libi.log | grep ${def.id}\` for the full stderr.`,
        ].join("\n"),
      );
    }
  }

  const durationMs = Date.now() - start;
  logger.info(
    { tag: "lifecycle", phase: "category-a", op: "done", durationMs },
    `Category A complete (${durationMs}ms)`,
  );
  lifecycleEvents.emit({ kind: "category-a-done", durationMs });
}
