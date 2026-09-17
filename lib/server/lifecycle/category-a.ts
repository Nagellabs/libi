/**
 * Category A — "Everything the editor needs is on disk."
 *
 * Runs in the CLI parent process (or Electron main process) BEFORE the
 * Next.js child is spawned. Blocks startup until the tier-1 set is on
 * disk: a spawnable Node.js runtime, ffmpeg and ffprobe. Nothing else —
 * as of 2026-09-08 every other binary (uv, yt-dlp, chromium, the MediaPipe
 * assets, the tracking engine) is a tier-2 dep of the extension that needs
 * it and installs on first use. The former phase 1 (`npm install` of
 * bundled MCP packages into `~/.libi/node_modules`) and phase 3 (an
 * in-memory probe of each tier-1 MCP) are gone with it: the first had
 * nothing left to install and the second nothing left to probe.
 *
 * Emits per-item lifecycle events so the CLI adapter can render `ora`
 * spinners and the Electron splash can render its progress UI. On any
 * step failure, throws a structured InstallPhaseError which `runner.ts`
 * converts into a fatal lifecycle event; the CLI exits with `process.exit(1)`.
 *
 * Hot path: filesystem version checks; ~50 ms.
 * Cold path: dominated by the ffmpeg/ffprobe static builds and the node
 * runtime download.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import { ensureLibiDirs } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";
import {
  ensureNodeRuntime,
  type NodeRuntimeOutcome,
  type NodeRuntimeProgress,
} from "@/lib/runtime/node-runtime";
import { lifecycleEvents } from "./events";
import { binaryInstallHints } from "./install-error-hints";
import type { InstallItem } from "./types";

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
  /**
   * Installs the tier-1 binary set — the `libi` core def's deps, which is
   * ffmpeg + ffprobe (`mcp/registry/bundled.ts`). Fatal on failure: the
   * editor cannot probe or export media without them.
   */
  installBinaryDeps: () => Promise<void>;
  /**
   * Guarantees a spawnable Node.js runtime at `<LIBI_HOME>/bin/node`
   * (`lib/runtime/node-runtime.ts`). NEVER throws — failure is reported via
   * the returned outcome, and this phase is non-fatal because a machine
   * without node still boots into a working Terminal surface. `onProgress`
   * lets the caller mirror the same install-start/-progress/-done
   * `lifecycleEvents` sequence every other phase emits (without it, a silent
   * multi-second download reads as a hang).
   */
  ensureNodeRuntime: (onProgress?: (p: NodeRuntimeProgress) => void) => Promise<NodeRuntimeOutcome>;
}

export const defaultCategoryADeps: CategoryADeps = {
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
        // A dep whose install token already matches is decided by a filesystem
        // check, not a download — open no "downloading…" row for it, or the
        // splash flashes a spinner for something that was never fetched.
        if (p.status === "skipped") {
          // No `started.add(...)` here: nothing opened a row for a skipped dep,
          // so there is nothing to mark as opened. A `skipped` tick is
          // also terminal for that binary — the install loop `continue`s past
          // it — so it can never be followed by a `downloading` one this would
          // have had to suppress.
          lifecycleEvents.emit({
            kind: "category-a-install-done",
            item,
            result: "skipped",
            reason: p.reason ?? "already installed",
          });
          return;
        }
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
  ensureNodeRuntime: (onProgress) => ensureNodeRuntime(undefined, onProgress),
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

/**
 * Human-readable status line for one node-runtime progress tick. Pure so the
 * copy is testable.
 *
 * NAMES NO DEPENDENCY. Every surface renders this next to the item's own
 * label — the CLI as `Downloading ${label} (${detail})`, the splash as
 * `${label} — ${detail}` — so a detail that repeats the label reads as
 * `Downloading Node.js runtime (downloading Node.js runtime — 12.8MB /
 * 49.7MB)`. ffmpeg and ffprobe, which carry no detail at all, always read
 * correctly; this is the phrasing that matches them.
 */
export function nodeRuntimeProgressDetail(p: NodeRuntimeProgress): string {
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)}MB`;
  switch (p.phase) {
    case "linking":
      return "linking an install already on this machine";
    case "downloading": {
      const bytes = p.bytesDownloaded ?? 0;
      if (p.bytesTotal) return `${mb(bytes)} / ${mb(p.bytesTotal)}`;
      // Before the response headers land there is no total and no bytes;
      // rendering that reads as "0.0MB", the same misleading zero the byte
      // rows guard against in the adapters.
      return bytes > 0 ? mb(bytes) : "connecting";
    }
    case "extracting":
      return "extracting the archive";
    case "installing":
      return "installing";
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

  // Phase 1: a Node.js runtime libi can spawn — NEVER fatal.
  //
  // RUNS BEFORE THE BINARY DEPS, deliberately. Any custom installer that
  // shells out to a Node program resolves its interpreter through
  // `resolveNodeCommand()`, which returns bare `"node"` until this phase has
  // put one at `<LIBI_HOME>/bin/node`. On a machine whose only node lives in
  // a version manager — the common macOS case — a Finder-launched .app has no
  // node on PATH, so back when `playwright-chromium` was tier-1 its install
  // failed on the first boot and only succeeded on the second, once this
  // phase had run. It self-healed, which is why this is minor rather than a
  // blocker, but the ordering was simply backwards.
  //
  // The libi MCP and both ACP adapters are spawned as Node programs by
  // processes libi does not own, so they need a real `node` executable —
  // and a Finder-launched .app has a PATH with no version manager in it. See
  // `lib/runtime/node-runtime.ts` for the full story (including why
  // `process.execPath` and `utilityProcess.fork()` are both unavailable here).
  //
  // Non-fatal: a machine without node still boots into a working Terminal
  // surface, and
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
  syncLog("phase 1: calling ensureNodeRuntime");
  // The start event is emitted LAZILY, from the first progress tick — not here.
  // `ensureNodeRuntime` decides `already-managed` from a filesystem
  // check and reports no progress at all in that case, which is the common
  // path; emitting the start unconditionally opened a "downloading…" row on
  // the splash for a runtime that was never fetched, and the row then flipped
  // to `skipped` a few milliseconds later. No ticks, no row: the `skipped`
  // done event renders the whole story on its own. Both renderers already
  // handle a done with no preceding start (`adapters/cli.ts`, `splash.html`).
  let nodeStartEmitted = false;
  const emitNodeStart = (): void => {
    if (nodeStartEmitted) return;
    nodeStartEmitted = true;
    lifecycleEvents.emit({ kind: "category-a-install-start", item: NODE_RUNTIME_ITEM });
  };
  try {
    const nodeResult = await withTimeout(
      deps.ensureNodeRuntime((p) => {
        emitNodeStart();
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
      syncLog(`phase 1: node runtime ${nodeResult.source} at ${nodeResult.path}`);
      lifecycleEvents.emit({
        kind: "category-a-install-done",
        item: NODE_RUNTIME_ITEM,
        result: alreadyManaged ? "skipped" : "installed",
        reason: alreadyManaged ? "already installed" : undefined,
      });
    } else {
      logger.warn(
        { tag: "lifecycle", phase: "category-a", op: "node_runtime_failed", err: nodeResult.error },
        "Could not provision a Node.js runtime — the libi MCP and the agent adapters will fall back to `node` on PATH",
      );
      syncLog(`phase 1: node runtime FAILED: ${nodeResult.error}`);
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
    syncLog(`phase 1: node runtime THREW: ${message}`);
    lifecycleEvents.emit({
      kind: "category-a-install-done",
      item: NODE_RUNTIME_ITEM,
      result: "failed",
      reason: message,
    });
  }

  // Phase 2: binary deps — the tier-1 set, i.e. ffmpeg + ffprobe.
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

  const durationMs = Date.now() - start;
  logger.info(
    { tag: "lifecycle", phase: "category-a", op: "done", durationMs },
    `Category A complete (${durationMs}ms)`,
  );
  lifecycleEvents.emit({ kind: "category-a-done", durationMs });
}
