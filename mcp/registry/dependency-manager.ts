import { execSync, execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";
import { getDb } from "@/lib/db/client";
import { trackServerEvent } from "@/lib/analytics/server";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { BUNDLED_MCP_SERVERS } from "./bundled";
import { probeAndPersist as proberProbeAndPersist } from "./server-prober";
import {
  getCustomInstaller,
  YT_DLP_UV_TOKEN,
  ytDlpTokenPath,
  ytDlpUvInstallArgs,
  ENSURE_CHROMIUM_INSTALL_SENTINEL,
  PLAYWRIGHT_CHROMIUM_INSTALLER_ID,
} from "./installers";
import {
  depDbWritesSuppressed,
  readDepTransition,
  setDepDbWritesSuppressed,
  writeDepTransition as persistDepTransition,
} from "./dep-transition";
import { depInstallAcceptedAt, isDepInstalling } from "./dep-in-flight";
import {
  CHROMIUM_DEP_BINARY,
  CHROMIUM_MCP_ID,
  chromiumInstallInFlight,
  ensureChromium,
} from "@/lib/export/ensure-chromium";
import { exeSuffix, isWindows } from "@/lib/platform";
import type {
  BundledDependency,
  BundledMcpDef,
  DependencyStatus,
  DepRuntimeStatus,
  InstallStatus,
} from "./types";
import { getLibiBinDir, getLibiModelsDir } from "@/lib/libi-home";
import { buildUvEnv } from "@/lib/uv-env/spawn-env";
import { serverLogger as logger } from "@/lib/logger";
import {
  verifySha256,
  downloadBufferWithStallGuard,
  DownloadStalledError,
  type DownloadRetryInfo,
} from "@/lib/security/download-verify";
import { resolveGlob } from "@/lib/file/glob";
import {
  ensureBootstrapped,
  getVirtualDepsForMcp,
} from "@/lib/mcp-virtual-deps/registry";

const execFileAsync = promisify(execFile);

export interface BinaryInstallProgress {
  binary: string;
  mcpId: string;
  /** Bytes downloaded so far for the current binary, when applicable. */
  bytesDownloaded?: number;
  bytesTotal?: number | null;
  status: "downloading" | "extracting" | "skipped" | "done";
  reason?: string;
  /**
   * Renderer-ready status text that WINS over the byte counts when present
   * (mirrors `CategoryAInstallProgressEvent.detail`). Used to surface retry
   * state — "download stalled — retrying (attempt 2 of 3)" — so a stalling
   * download is visibly stalling instead of indistinguishable from a
   * working one.
   */
  detail?: string;
}

export type BinaryInstallProgressCallback = (p: BinaryInstallProgress) => void;

interface ResolvedStatus {
  binary: string;
  installed: boolean;
  path: string | null;
  source: "system" | "bundled" | null;
  runtimeStatus: DepRuntimeStatus;
  /** Present while an install is in flight in this process (chromium). */
  bytesDownloaded?: number;
  bytesTotal?: number;
  /** Present when the last install attempt failed and nothing landed since. */
  error?: string | null;
}

export class DependencyManager {
  /**
   * When true, every DB write in the install path (`ensureMcp`,
   * `retryDep`, `writeDepTransition`, etc.) becomes a no-op.
   *
   * Category A runs BEFORE migrations (those are owned by Category B),
   * so its DB writes would target a schemaless DB and either hang or
   * error. Setting this flag preserves the architectural invariant
   * "Category A only touches the filesystem" — Category B's
   * `settleAllBundledStatuses()` later recomputes every row's status
   * from on-disk state after migrations are in place.
   *
   * Default `false` preserves the original behaviour for every other
   * caller (Settings UI resync, retry, etc.).
   *
   * Backed by the module-level flag in `./dep-transition.ts` rather than by an
   * instance field: the leaf writer is shared with
   * `lib/export/ensure-chromium.ts` and cannot read instance state, so a
   * second copy of this flag would be a copy that can disagree. Process-scoped
   * — which is what the invariant is, "this process runs before migrations" —
   * and the reason `setSkipDbWrites` is only ever called by Category A.
   */
  private get skipDbWrites(): boolean {
    return depDbWritesSuppressed();
  }

  /**
   * RC-E: binaries whose download we've already logged as "unverified" this
   * process, so the one-time warning isn't spammed on every re-check.
   */
  private static readonly unverifiedBinariesWarned = new Set<string>();

  /**
   * RC-E: content-verify a freshly-downloaded binary against its pinned
   * sha256 when present; otherwise log a ONE-TIME warning that the binary
   * was fetched without integrity verification (its URL is a moving
   * "latest" alias with no stable hash). Runs before chmod / install-token.
   * On mismatch the tampered/corrupt file is unlinked and the install throws.
   */
  private async verifyBinaryIntegrity(
    dep: BundledDependency,
    filePath: string,
  ): Promise<void> {
    if (dep.sha256) {
      try {
        await verifySha256(filePath, dep.sha256);
      } catch (err) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* best-effort cleanup of the bad artifact */
        }
        throw err;
      }
      logger.info(
        {
          tag: "security",
          op: "binary_verified",
          binary: dep.binary,
          sha256Prefix: dep.sha256.slice(0, 16),
        },
        `Verified sha256 of downloaded binary "${dep.binary}"`,
      );
      return;
    }
    if (!DependencyManager.unverifiedBinariesWarned.has(dep.binary)) {
      DependencyManager.unverifiedBinariesWarned.add(dep.binary);
      logger.warn(
        {
          tag: "security",
          op: "binary_unverified",
          binary: dep.binary,
        },
        `Downloaded binary "${dep.binary}" WITHOUT sha256 verification — its ` +
          `download URL is a "latest" alias with no pinned hash (transport ` +
          `was HTTPS-only). Re-host as a pinned release asset + set the dep's ` +
          `sha256 to enable content verification.`,
      );
    }
  }

  setSkipDbWrites(skip: boolean): void {
    setDepDbWritesSuppressed(skip);
  }

  /**
   * Ensure all bundled MCP binary dependencies are installed AND the spawn-based
   * MCPs have been pre-warmed (initial probe spawn populates npx/uvx package
   * caches so the first agent session doesn't pay the download cost).
   *
   * DB rows are seeded by seedDatabase() in lib/db/init.ts.
   *
   * Two phases:
   *   1. installBundledDeps — download/install binary deps for each bundled MCP.
   *   2. prewarmBundledMcps — spawn each non-core, non-http MCP via the probe
   *      flow so its launch command (e.g. `npx -y @kevinwatt/yt-dlp-mcp@latest`)
   *      populates the relevant package cache before any agent session uses it.
   */
  async ensureAll(options?: {
    failedOnly?: boolean;
    onProgress?: BinaryInstallProgressCallback;
    tier?: "tier-1" | "all";
  }): Promise<void> {
    await this.installBundledDeps(options);
    await this.prewarmBundledMcps(options);
  }

  /**
   * Phase 1: install binary deps for every bundled MCP. Does NOT probe / spawn
   * the MCP itself — that's `prewarmBundledMcps`.
   */
  // Sync log helper — bypasses pino buffering so we can pinpoint hangs
  // in packaged Electron where the worker-thread transport may swallow
  // late writes.
  private static syncLog(line: string): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require("node:path") as typeof import("node:path");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const os = require("node:os") as typeof import("node:os");
      const logDir = path.join(
        process.env.LIBI_HOME ?? path.join(os.homedir(), ".libi"),
        "logs",
      );
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, "category-a-sync.log"),
        `[${new Date().toISOString()}] dm: ${line}\n`,
      );
    } catch {
      /* never throw from a logger */
    }
  }

  async installBundledDeps(options?: {
    failedOnly?: boolean;
    onProgress?: BinaryInstallProgressCallback;
    /**
     * Restrict the install loop to a tier. "tier-1" is used by Category A
     * (the CLI-blocking startup install) so tier-2 MCPs (yt-dlp-mcp,
     * elevenlabs, fal-ai) are not fetched at boot. Defaults to "all" so
     * the existing `ensureAll` / Settings resync paths still touch every
     * bundled MCP — those flows are explicitly user-initiated and may
     * include tier-2 reinstalls.
     */
    tier?: "tier-1" | "all";
  }): Promise<void> {
    this.ensureBinDir();

    const tier = options?.tier ?? "all";
    // A tier-1 sweep is exactly the tier-1 DEFS.
    //
    // There used to be a second admission rule here — a tier-2 def carrying a
    // dep flagged `installFlow: "tier-1"` (the comment named yt-dlp under
    // youtube-downloader) also entered the loop, and a branch below installed
    // just those deps directly so `ensureMcp` would not flip the parent's
    // `installStatus` to "installed". uv and yt-dlp were de-tiered on
    // 2026-09-08 and no def has carried a tier-1-flagged dep since, so both
    // the rule and the branch were unreachable. Rather than keep a dead
    // install path warm, the shape is now unsupported and says so out loud:
    // Category A must never install something it was not asked for on the
    // strength of a flag nobody is reading. `__tests__/unit/server/lifecycle/
    // category-a.test.ts` pins that no def carries one.
    const defs =
      tier === "tier-1"
        ? BUNDLED_MCP_SERVERS.filter((def) => (def.installFlow ?? "tier-1") === "tier-1")
        : BUNDLED_MCP_SERVERS;
    if (tier === "tier-1") {
      for (const def of BUNDLED_MCP_SERVERS) {
        if ((def.installFlow ?? "tier-1") === "tier-1") continue;
        const strays = def.dependencies.filter((d) => d.installFlow === "tier-1");
        if (strays.length === 0) continue;
        logger.warn(
          {
            tag: "lifecycle",
            op: "tier1_dep_on_tier2_def",
            mcpId: def.id,
            binaries: strays.map((d) => d.binary),
          },
          "a tier-2 MCP declares a tier-1 dep; Category A does not install it — move the dep, or the MCP, to tier 1",
        );
      }
    }

    DependencyManager.syncLog(`installBundledDeps: ${defs.length} defs, tier=${tier}`);
    for (const def of defs) {
      DependencyManager.syncLog(`def loop: ${def.id} (deps=${def.dependencies.length})`);
      if (options?.failedOnly) {
        const db = getDb();
        const [row] = db
          .select()
          .from(mcpServers)
          .where(eq(mcpServers.id, def.id))
          .limit(1)
          .all();
        if (row && row.installStatus !== "failed") continue;
      }
      await this.ensureMcp(def, options?.onProgress);
    }
  }

  /**
   * Phase 2: pre-warm every spawn-based bundled MCP by running its probe.
   *
   * The probe spawns the MCP's launch command (`npx -y ...`, `uvx ...`, etc.),
   * sends an `initialize` JSON-RPC request, waits for the first stdout, and
   * kills the child. The side-effect is that the package is downloaded into
   * the local npm/uv cache, so subsequent spawns (e.g. from an agent session)
   * are fast (cache-hit) instead of paying a 20-30s download cost.
   *
   * Skips:
   *   - `core` MCPs (libi — synthesized at runtime, never spawned externally)
   *   - `type: "http"` MCPs (no stdio process to spawn)
   *   - MCPs whose `installStatus` is not `installed` / `not_required`
   *     (deps missing → probe would just fail)
   *
   * Persists each probe result into the `mcp_servers` row (status + error +
   * lastChecked). Logs per-MCP start/done with durations under the
   * `mcp-prewarm` tag so investigations can grep one line.
   */
  async prewarmBundledMcps(options?: {
    failedOnly?: boolean;
    /**
     * Restrict the pre-warm sweep to a tier. "tier-1" is used by Category B
     * so we never try to spawn (and thereby probe-fail) tier-2 MCPs that
     * haven't been installed by the agent yet. Defaults to "all" so the
     * existing `ensureAll` / resync paths still pre-warm every MCP after
     * a user-initiated install.
     */
    tier?: "tier-1" | "all";
  }): Promise<void> {
    const tier = options?.tier ?? "all";
    const candidates = BUNDLED_MCP_SERVERS.filter((def) => {
      if (def.core) return false;
      if (def.noServer) return false;
      if (def.type === "http") return false;
      if (tier === "tier-1" && (def.installFlow ?? "tier-1") !== "tier-1") {
        return false;
      }
      return true;
    });

    const overallStart = Date.now();
    logger.info(
      {
        tag: "mcp-prewarm",
        op: "batch_start",
        count: candidates.length,
        ids: candidates.map((d) => d.id),
        failedOnly: options?.failedOnly === true,
      },
      `Pre-warming ${candidates.length} bundled MCP server(s)`,
    );

    type Result = { id: string; status: string; durationMs: number; skipped?: string };
    const results: Result[] = [];
    for (const def of candidates) {
      results.push(await this.prewarmMcp(def, options));
    }

    logger.info(
      {
        tag: "mcp-prewarm",
        op: "batch_done",
        durationMs: Date.now() - overallStart,
        results,
      },
      `Pre-warm batch done in ${Date.now() - overallStart}ms`,
    );
  }

  /**
   * Pre-warm a single MCP server. Public so callers (test stubs, settings
   * retry, etc.) can drive a single MCP through the probe lifecycle.
   */
  async prewarmMcp(
    def: BundledMcpDef,
    options?: { failedOnly?: boolean },
  ): Promise<{ id: string; status: string; durationMs: number; skipped?: string }> {
    if (def.core) {
      return { id: def.id, status: "skipped", durationMs: 0, skipped: "core" };
    }
    if (def.noServer) {
      return { id: def.id, status: "skipped", durationMs: 0, skipped: "no-server" };
    }
    if (def.type === "http") {
      return { id: def.id, status: "skipped", durationMs: 0, skipped: "http" };
    }

    const db = getDb();
    const [row] = db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, def.id))
      .limit(1)
      .all();

    const installOk =
      row?.installStatus === "installed" || row?.installStatus === "not_required";
    if (!installOk) {
      logger.info(
        {
          tag: "mcp-prewarm",
          op: "skip",
          mcpId: def.id,
          reason: "install_not_ready",
          installStatus: row?.installStatus ?? null,
        },
        `Skipping pre-warm for "${def.id}" — install not ready`,
      );
      return {
        id: def.id,
        status: "skipped",
        durationMs: 0,
        skipped: "install_not_ready",
      };
    }

    if (options?.failedOnly && row.serverStatus !== "down") {
      return {
        id: def.id,
        status: "skipped",
        durationMs: 0,
        skipped: "not_failed",
      };
    }

    const start = Date.now();
    logger.info(
      {
        tag: "mcp-prewarm",
        op: "start",
        mcpId: def.id,
        command: def.command,
        args: def.args,
      },
      `Pre-warming MCP "${def.id}" (${def.command} ${(def.args ?? []).join(" ")})`,
    );

    try {
      const probe = await proberProbeAndPersist(def);
      const durationMs = Date.now() - start;
      logger.info(
        {
          tag: "mcp-prewarm",
          op: "done",
          mcpId: def.id,
          status: probe.status,
          durationMs,
        },
        `Pre-warm done for "${def.id}" (${probe.status}, ${durationMs}ms)`,
      );
      return { id: def.id, status: probe.status, durationMs };
    } catch (err) {
      const durationMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        {
          tag: "mcp-prewarm",
          op: "error",
          mcpId: def.id,
          durationMs,
          err: message,
        },
        `Pre-warm threw for "${def.id}"`,
      );
      return { id: def.id, status: "error", durationMs };
    }
  }

  /** Get the bin directory path. */
  static getBinDir(): string {
    return getLibiBinDir();
  }

  /**
   * Pick the right entry from a PlatformValue for the current process.
   * Falls back gracefully: if the platform value is a plain string, return it;
   * if it's arch-keyed, prefer process.arch, else the only entry present.
   */
  private static pickPlatformValue<T>(value: import("./types").PlatformValue<T>): T {
    const platform = process.platform as "darwin" | "linux" | "win32";
    const entry = value[platform];
    if (entry === undefined) {
      throw new Error(`No download URL for platform=${platform}`);
    }
    if (typeof entry === "string") return entry as T;
    // Arch-keyed object
    const arch = process.arch as import("./types").NodeArch;
    const archEntry = (entry as Partial<Record<import("./types").NodeArch, T>>)[arch];
    if (archEntry !== undefined) return archEntry;
    // Fallback: return whichever arch entry is present (best-effort)
    const fallback = Object.values(entry as Record<string, T>).find((v) => v !== undefined);
    if (fallback === undefined) {
      throw new Error(`No download URL for platform=${platform}, arch=${arch}`);
    }
    return fallback;
  }

  /** Resolve the download URL for a standard-mode dependency on the current platform/arch. */
  static resolveDownloadUrl(dep: import("./types").BundledDependency): string {
    if (!dep.downloadUrl) {
      throw new Error(
        `Dependency ${dep.binary} has no downloadUrl — likely a customInstaller dep called via the wrong path.`,
      );
    }
    return DependencyManager.pickPlatformValue(dep.downloadUrl);
  }

  /** Resolve the binary path inside an archive for the current platform/arch. */
  static resolveBinaryPathInArchive(dep: import("./types").BundledDependency): string {
    if (!dep.archive) {
      throw new Error(`Dependency ${dep.binary} has no archive metadata`);
    }
    return DependencyManager.pickPlatformValue(dep.archive.binaryPathInArchive);
  }

  /** Public API: resolve current status for each dep of an MCP without downloading. */
  async getStatuses(mcpId: string): Promise<DependencyStatus[]> {
    ensureBootstrapped();
    const def = BUNDLED_MCP_SERVERS.find((d) => d.id === mcpId);
    const binary: DependencyStatus[] = def
      ? await Promise.all(
          def.dependencies.map(async (dep) => {
            const status = await this.resolveStatusAsync(dep, mcpId);
            // An install the retry-dep route has ACCEPTED but
            // whose runner has not yet announced itself (ensureChromium's
            // flight, or the first `writeDepTransition`) still resolves as
            // `pending` here — and the chip's pending branch offers the
            // Download button again, so a second click starts a second
            // 173 MB download. Report the accepted install as installing;
            // the spinner branch renders no button at all. Only ever
            // WIDENS to installing, so a flight already reporting its bytes
            // keeps them.
            const shown: ResolvedStatus =
              status.runtimeStatus !== "installing" && isDepInstalling(mcpId, dep.binary)
                ? {
                    binary: status.binary,
                    installed: false,
                    path: null,
                    source: null,
                    runtimeStatus: "installing",
                  }
                : status;
            // Only ever added, never `manualInstall: false` — the chip and
            // the persisted transitions treat absence as "Category A dep".
            return dep.manualInstall ? { ...shown, manualInstall: true } : shown;
          }),
        )
      : [];
    const virtual = await Promise.all(
      getVirtualDepsForMcp(mcpId).map((d) =>
        d.inspect().catch((err): DependencyStatus => ({
          binary: d.label,
          installed: false,
          path: null,
          source: null,
          runtimeStatus: "failed",
          error: err instanceof Error ? err.message : String(err),
        })),
      ),
    );
    return [...binary, ...virtual];
  }

  /**
   * Refresh a single MCP's persisted aggregate (`installStatus`,
   * `installError`, `dependencyStatus`) from the current on-disk + virtual-dep
   * state — without triggering downloads or spawning the MCP. Idempotent.
   *
   * Why this exists: an install path can return early when a dep is already
   * system-installed, without ever writing `dependencyStatus`. The seed
   * default `installStatus = "pending"` then sticks forever for MCPs whose
   * deps were already met — the badge reads that pending and shows
   * "Checking…" indefinitely.
   *
   * Called from Category B after `installBundledDeps` so every bundled row
   * converges to a truthful install state on every boot. Skips `core` MCPs
   * (libi's row is managed by ensureMcp/seedDatabase). Preserves a row's
   * `failed` state (a real install attempt failed and the user should retry).
   */
  async settleInstallStatus(mcpId: string): Promise<InstallStatus | null> {
    const def = BUNDLED_MCP_SERVERS.find((d) => d.id === mcpId);
    if (!def || def.core) return null;

    const db = getDb();
    const [row] = db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, mcpId))
      .limit(1)
      .all();
    if (!row) return null;

    // A row parked at `failed` is preserved: a real install attempt failed and
    // the user should keep seeing the retry affordance until they take it.
    //
    // This used to read `=== "failed" || === "installing"`, behind an
    // `as InstallStatus` cast. "installing" is not a member of
    // `InstallStatus` and nothing in the codebase has ever written it to this
    // column — `installing` is a per-DEP `runtimeStatus`, not an aggregate —
    // so the second half was a guard against a value that cannot occur, and
    // the cast is what stopped the compiler saying so. If an aggregate
    // "installing" is ever wanted it has to be a real member of the type and
    // it has to be reconciled against `chromiumInstallInFlight()` /
    // `isDepInstalling`, or a crash mid-download pins the row forever.
    if (row.installStatus === "failed") return "failed";

    const statuses = await this.getStatuses(mcpId);
    const allDepsInstalled = statuses.every((s) => s.installed);

    let aggregate: InstallStatus;
    // Nothing to configure once deps are on disk (libi holds no provider key).
    const installError: string | null = null;
    if (!allDepsInstalled) {
      aggregate = "pending";
    } else if (def.dependencies.length === 0 && getVirtualDepsForMcp(mcpId).length === 0) {
      aggregate = "not_required";
    } else {
      aggregate = "installed";
    }

    db.update(mcpServers)
      .set({
        installStatus: aggregate,
        installError,
        dependencyStatus: JSON.stringify(statuses),
        updatedAt: new Date(),
      })
      .where(eq(mcpServers.id, mcpId))
      .run();

    // If the row had a stale serverStatus from a previous probe and is no
    // longer in a probeable state, reset it so the UI doesn't show "down"
    // for an MCP whose deps/env are now incomplete (or whose probe was
    // never re-run after a config change).
    const probeable = aggregate === "installed" || aggregate === "not_required";
    if (!probeable && row.serverStatus !== "unknown") {
      db.update(mcpServers)
        .set({
          serverStatus: "unknown",
          serverError: null,
          updatedAt: new Date(),
        })
        .where(eq(mcpServers.id, mcpId))
        .run();
    }

    return aggregate;
  }

  /** Run `settleInstallStatus` for every non-core bundled MCP. */
  async settleAllBundledStatuses(): Promise<void> {
    for (const def of BUNDLED_MCP_SERVERS) {
      if (def.core) continue;
      try {
        await this.settleInstallStatus(def.id);
      } catch (err) {
        logger.warn(
          {
            tag: "mcp-settle",
            op: "settle_failed",
            mcpId: def.id,
            err: err instanceof Error ? err.message : String(err),
          },
          `settleInstallStatus failed for "${def.id}"`,
        );
      }
    }
  }

  private static findBundledDep(mcpId: string, binary: string): BundledDependency {
    const def = BUNDLED_MCP_SERVERS.find((d) => d.id === mcpId);
    if (!def) throw new Error(`No bundled MCP with id ${mcpId}`);
    const dep = def.dependencies.find((d) => d.binary === binary);
    if (!dep) throw new Error(`No dep ${binary} on MCP ${mcpId}`);
    return dep;
  }

  /**
   * Bring ONE bundled dependency onto disk if it is not there already.
   *
   * This is the on-demand entry point for code that needs a tier-2 dep at
   * the moment of use (the tracker's `mediapipe-vision` before every
   * Chromium launch; `uv` before the tracking engine's `uv sync`). When the
   * dep is already installed — every `files[]` entry present with a
   * matching install token, a token-matching binary in `bin/`, or a custom
   * installer whose `verify()` reports a path — it returns at once: no
   * download, no `runtimeStatus: "installing"` transition, nothing for the
   * Settings chips to flicker over. Otherwise it does exactly what
   * `retryDep` does.
   *
   * "Installed" is a deliberate trade, not a full verification: a
   * multi-file dep counts as installed when every file EXISTS and the
   * install token matches — no per-start sha256 of 33 MB of MediaPipe
   * assets. An asset corrupted in place therefore passes here; the repair
   * for that is `retryDep` (the Settings retry chip), which always
   * re-downloads.
   *
   * `retryDep` is deliberately NOT this: it is the Settings "Retry" button
   * and always re-runs the install. Routing the tracker through it
   * re-downloaded all 33 MB of MediaPipe assets on every tracker start and
   * made tracking fail offline with the assets sitting on disk.
   */
  async ensureDep(mcpId: string, binary: string): Promise<void> {
    const dep = DependencyManager.findBundledDep(mcpId, binary);
    const installed = dep.files
      ? this.isMultiFileInstalled(dep)
      : (await this.resolveStatusAsync(dep, mcpId)).installed;
    if (installed) return;
    await this.retryDep(mcpId, binary);
  }

  /**
   * Retry installation of a single failed dependency. Writes runtime state
   * transitions so the Settings UI's polling sees `installing → installed`
   * (or `installing → failed`) without waiting for the full `ensureAll`
   * sweep. Always installs — use `ensureDep` for "install only if missing".
   */
  async retryDep(mcpId: string, binary: string): Promise<void> {
    const dep = DependencyManager.findBundledDep(mcpId, binary);

    this.ensureBinDir();
    this.writeDepTransition(mcpId, binary, {
      runtimeStatus: "installing",
      error: null,
    });
    try {
      if (dep.files) {
        await this.installMultiFile(dep);
      } else if (dep.customInstallerId) {
        await this.runCustomInstaller(dep);
      } else {
        const url = DependencyManager.resolveDownloadUrl(dep);
        await this.downloadGroup(url, [dep]);
      }
      const fresh = await this.resolveStatusAsync(dep, mcpId);
      if (!fresh.installed) {
        this.writeDepTransition(mcpId, binary, {
          runtimeStatus: "failed",
          error: "Install completed without throwing, but binary still not detected.",
        });
        return;
      }
      this.writeDepTransition(mcpId, binary, fresh);
      // Verified present, not merely "the download finished" — the boot diet
      // made this the install path for everything but node and ffmpeg.
      trackServerEvent("dependency_installed", { extension: mcpId, dep: binary });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { mcpId, binary, err: message },
        "retryDep failed",
      );
      this.writeDepTransition(mcpId, binary, {
        runtimeStatus: "failed",
        error: message,
      });
      throw err;
    }
  }

  private ensureBinDir(): void {
    if (!fs.existsSync(getLibiBinDir())) {
      fs.mkdirSync(getLibiBinDir(), { recursive: true });
    }
  }

  private async ensureMcp(
    def: BundledMcpDef,
    onProgress?: BinaryInstallProgressCallback,
  ): Promise<void> {
    DependencyManager.syncLog(`ensureMcp(${def.id}): before getDb()`);
    const db = getDb();
    DependencyManager.syncLog(`ensureMcp(${def.id}): after getDb()`);
    const mcpId = def.id;
    DependencyManager.syncLog(`ensureMcp(${def.id}): deps=${def.dependencies.length}`);

    if (def.dependencies.length === 0) {
      // No binary deps and nothing to configure (libi holds no provider
      // key) → not_required.
      if (this.skipDbWrites) {
        // Category A path: don't touch DB. Category B's
        // settleAllBundledStatuses recomputes this from disk after
        // migrations have run.
        return;
      }
      db.update(mcpServers)
        .set({
          installStatus: "not_required",
          installError: null,
          dependencyStatus: JSON.stringify([]),
          updatedAt: new Date(),
        })
        .where(eq(mcpServers.id, mcpId))
        .run();
      // Probing (= spawn pre-warm) is now done in a separate phase by
      // `prewarmBundledMcps`. We just settle install state here.
      return;
    }

    // Mark whole MCP as checking while we work.
    if (!this.skipDbWrites) {
      DependencyManager.syncLog(`ensureMcp(${mcpId}): UPDATE mcpServers SET installStatus=checking`);
      db.update(mcpServers)
        .set({ installStatus: "checking" as InstallStatus, updatedAt: new Date() })
        .where(eq(mcpServers.id, mcpId))
        .run();
      DependencyManager.syncLog(`ensureMcp(${mcpId}): UPDATE done`);
    }

    const perBinErrors: string[] = [];
    // Per-binary install failures captured during the loop so the final
    // statuses array can carry runtimeStatus: "failed" + error message even
    // though resolveStatusAsync only knows about the post-install filesystem
    // state (which would otherwise render as "pending").
    const depFailures = new Map<string, string>();

    // Install order is load-bearing: fileDeps → standardDeps → customDeps.
    // A custom installer may shell out to a STANDARD dep of the same def
    // (`yt-dlp` runs `uv tool install`; `tracking-pyenv` runs `uv sync`), so
    // every standard dep must be on disk before any custom installer starts.
    // Until 2026-09-08 `uv` was flagged tier-1 and Category A had already
    // put it in bin/ by the time a tier-2 def installed on demand; that flag
    // is gone, so both youtube-downloader and libi-tracking now declare `uv`
    // themselves and this loop order guarantees it for everything that
    // installs through here. It is NOT the only path, though: the
    // tracking_engine_install job (lib/jobs/runners/tracking-engine-install.ts)
    // calls `retryDep` on the pyenv dep directly, bypassing this loop, and
    // so `ensureDep`s uv explicitly first. Custom-installer deps run on
    // their own — they don't share archives.
    const fileDeps = def.dependencies.filter((d) => d.files);
    const customDeps = def.dependencies.filter((d) => d.customInstallerId && !d.files);
    const standardDeps = def.dependencies.filter((d) => !d.customInstallerId && !d.files);

    // Group standard deps by download URL so archives are fetched once per platform.
    const downloadGroups = new Map<string, BundledDependency[]>();
    for (const dep of standardDeps) {
      const url = DependencyManager.resolveDownloadUrl(dep);
      const existing = downloadGroups.get(url) ?? [];
      existing.push(dep);
      downloadGroups.set(url, existing);
    }

    for (const dep of fileDeps) {
      if (this.isMultiFileInstalled(dep)) {
        onProgress?.({ binary: dep.binary, mcpId, status: "skipped", reason: "already installed" });
        continue;
      }
      this.writeDepTransition(mcpId, dep.binary, {
        runtimeStatus: "installing",
        error: null,
      });
      onProgress?.({ binary: dep.binary, mcpId, status: "downloading" });
      try {
        await this.installMultiFile(dep);
        const fresh = await this.resolveStatusAsync(dep);
        this.writeDepTransition(mcpId, dep.binary, fresh);
        onProgress?.({ binary: dep.binary, mcpId, status: "done" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        perBinErrors.push(`${dep.binary}: ${message}`);
        logger.error({ binary: dep.binary, err: message }, "Multi-file installer failed");
        depFailures.set(dep.binary, message);
        this.writeDepTransition(mcpId, dep.binary, {
          runtimeStatus: "failed",
          error: message,
        });
      }
    }

    for (const [url, deps] of downloadGroups) {
      // Fast-path: skip download if all deps in this group are already installed.
      const allInstalled = deps.every((d) => this.resolveStatus(d).installed);
      if (allInstalled) {
        for (const dep of deps) {
          onProgress?.({ binary: dep.binary, mcpId, status: "skipped", reason: "already installed" });
        }
        continue;
      }

      // Snapshot which deps actually need install before the download mutates disk state.
      const needsInstall = new Set<string>();
      for (const dep of deps) {
        if (this.resolveStatus(dep).installed) {
          onProgress?.({ binary: dep.binary, mcpId, status: "skipped", reason: "already installed" });
        } else {
          needsInstall.add(dep.binary);
          this.writeDepTransition(mcpId, dep.binary, {
            runtimeStatus: "installing",
            error: null,
          });
          onProgress?.({ binary: dep.binary, mcpId, status: "downloading" });
        }
      }
      try {
        await this.downloadGroup(url, deps, onProgress ? (p) => {
          // Forward byte-level progress from downloadGroup to each dep in the group.
          // downloadGroup emits progress for the shared download; we fan out to deps needing install.
          for (const dep of deps) {
            if (needsInstall.has(dep.binary)) {
              onProgress({ ...p, binary: dep.binary, mcpId });
            }
          }
        } : undefined);
        for (const dep of deps) {
          if (needsInstall.has(dep.binary)) {
            onProgress?.({ binary: dep.binary, mcpId, status: "done" });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        perBinErrors.push(`${deps.map((d) => d.binary).join(", ")}: ${message}`);
        logger.error({ binaries: deps.map((d) => d.binary), err: message },
          "Failed to download dependency group");
        for (const dep of deps) {
          depFailures.set(dep.binary, message);
          this.writeDepTransition(mcpId, dep.binary, {
            runtimeStatus: "failed",
            error: message,
          });
        }
      }
    }

    for (const dep of customDeps) {
      const existing = await this.resolveStatusAsync(dep);
      if (existing.installed) {
        onProgress?.({ binary: dep.binary, mcpId, status: "skipped", reason: "already installed" });
        continue;
      }
      this.writeDepTransition(mcpId, dep.binary, {
        runtimeStatus: "installing",
        error: null,
      });
      onProgress?.({ binary: dep.binary, mcpId, status: "downloading" });
      try {
        await this.runCustomInstaller(dep);
        onProgress?.({ binary: dep.binary, mcpId, status: "done" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        perBinErrors.push(`${dep.binary}: ${message}`);
        logger.error({ binary: dep.binary, err: message }, "Custom installer failed");
        depFailures.set(dep.binary, message);
        this.writeDepTransition(mcpId, dep.binary, {
          runtimeStatus: "failed",
          error: message,
        });
      }
    }

    // Category A path: skip the post-install DB settle entirely. Category B's
    // `settleAllBundledStatuses` recomputes this from disk after migrations
    // have run, and the resolve work below requires async disk I/O that's
    // wasted if we're not going to persist it.
    if (this.skipDbWrites) return;

    // Re-resolve after work.
    const resolved = await Promise.all(
      def.dependencies.map((dep) => this.resolveStatusAsync(dep)),
    );
    // Overlay in-flight install failures onto the freshly-resolved statuses
    // so the persisted JSON reflects "failed" (with an error) rather than
    // bare "pending" for deps whose install threw.
    const statuses: DependencyStatus[] = resolved.map((s) => {
      const failure = depFailures.get(s.binary);
      if (failure && !s.installed) {
        return { ...s, runtimeStatus: "failed", error: failure };
      }
      return s;
    });
    const allInstalled = statuses.every((s) => s.installed);

    let aggregate: InstallStatus;
    let installError: string | null;
    if (!allInstalled) {
      aggregate = "failed";
      installError = perBinErrors.join(" | ") || "unknown";
    } else {
      aggregate = "installed";
      installError = null;
    }

    db.update(mcpServers)
      .set({
        installStatus: aggregate,
        installError,
        dependencyStatus: JSON.stringify(statuses),
        updatedAt: new Date(),
      })
      .where(eq(mcpServers.id, mcpId))
      .run();

    // After install settles, mark MCPs whose deps failed as "down" so the
    // separate pre-warm phase knows to skip them. Probing (= spawn pre-warm)
    // is done in `prewarmBundledMcps` after the install loop. (`not_required`
    // isn't reachable in this branch — it's only set in the zero-deps fast
    // path above, which returns early.)
    if (def.core) return;
    if (aggregate !== "installed") {
      db.update(mcpServers)
        .set({
          serverStatus: "down",
          serverError: `Dependencies not installed: ${installError ?? "unknown"}`,
          serverLastChecked: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(mcpServers.id, mcpId))
        .run();
    }
  }

  /**
   * Patch the live `dependencyStatus` JSON for a single binary so callers (UI,
   * agent) can see in-flight transitions before `ensureMcp` finishes its
   * aggregate refresh. The write itself lives in `./dep-transition.ts` (a
   * leaf) because `lib/export/ensure-chromium.ts` writes the same transitions
   * — plus bytes — for the Chromium download, and this class now calls INTO
   * ensure-chromium for that dep, so sharing the method would be a cycle.
   * This wrapper only adds the Category A `skipDbWrites` guard.
   */
  writeDepTransition(
    mcpId: string,
    binary: string,
    patch: Partial<DependencyStatus>,
  ): void {
    if (this.skipDbWrites) return;
    persistDepTransition(mcpId, binary, patch);
  }

  private resolveStatus(dep: BundledDependency): ResolvedStatus {
    if (dep.files) {
      const destRoot =
        dep.destination === "models" ? getLibiModelsDir() : getLibiBinDir();
      const destDir = path.join(destRoot, dep.binary);
      const filesOk = dep.files.every((f) =>
        fs.existsSync(path.join(destDir, f.relPath)),
      );
      const installed = filesOk && this.installTokenMatches(dep);
      return {
        binary: dep.binary,
        installed,
        path: installed ? destDir : null,
        source: installed ? "bundled" : null,
        runtimeStatus: installed ? "installed" : "pending",
      };
    }
    if (dep.customInstallerId) {
      // Sync-only path: custom installer's verify is async. Callers that need
      // accurate custom-installer status must use resolveStatusAsync. Return
      // optimistic "not installed" so the standard path doesn't short-circuit.
      return {
        binary: dep.binary,
        installed: false,
        path: null,
        source: null,
        runtimeStatus: "pending",
      };
    }
    // Check our own bin/ FIRST so the install-token marker applies. If
    // ~/.libi/bin/ is on the env PATH, `which` would also find this copy,
    // but short-circuiting on PATH would mark it `source: "system"` and
    // skip the marker check — bumping a pinnedInstallToken wouldn't
    // re-install.
    const binPath = this.getBinaryPath(dep.binary);
    if (fs.existsSync(binPath)) {
      const installed = this.installTokenMatches(dep);
      return {
        binary: dep.binary,
        installed,
        path: installed ? binPath : null,
        source: installed ? "bundled" : null,
        runtimeStatus: installed ? "installed" : "pending",
      };
    }
    // PATH-resolved binaries (e.g. user-installed yt-dlp): install-token
    // markers don't apply — we didn't put it there, we can't claim a
    // version for it. Skipped entirely when `requireBundled` is set —
    // typically because we need build-time features (drawtext, etc.) the
    // OS-package build doesn't include.
    if (!dep.requireBundled && this.binaryExistsOnPath(dep.binary)) {
      return {
        binary: dep.binary,
        installed: true,
        path: null,
        source: "system",
        runtimeStatus: "installed",
      };
    }
    return {
      binary: dep.binary,
      installed: false,
      path: null,
      source: null,
      runtimeStatus: "pending",
    };
  }

  /**
   * Async status check that honors a custom installer's `verify`. Use this
   * when computing the dependency's actual current state (e.g. after install
   * or for the Settings UI). Falls back to the sync check for standard deps.
   *
   * `mcpId` lets the custom-installer branch merge the persisted transition
   * (`./dep-transition.ts`) when the disk alone would say `pending`: a
   * `failed` from the last attempt keeps its error (the chip shows Retry +
   * the reason instead of Download as if nothing happened). A persisted
   * `installing` is NOT trusted on its own — a crash mid-download would leave
   * it behind forever — the in-process flight is what reports `installing`.
   */
  private async resolveStatusAsync(
    dep: BundledDependency,
    mcpId?: string,
  ): Promise<ResolvedStatus> {
    if (dep.files) {
      const destRoot =
        dep.destination === "models" ? getLibiModelsDir() : getLibiBinDir();
      const destDir = path.join(destRoot, dep.binary);
      const filesOk = dep.files.every((f) =>
        fs.existsSync(path.join(destDir, f.relPath)),
      );
      const installed = filesOk && this.installTokenMatches(dep);
      return {
        binary: dep.binary,
        installed,
        path: installed ? destDir : null,
        source: installed ? "bundled" : null,
        runtimeStatus: installed ? "installed" : "pending",
      };
    }
    if (dep.customInstallerId) {
      const installer = getCustomInstaller(dep.customInstallerId);
      if (!installer) {
        logger.warn(
          { binary: dep.binary, customInstallerId: dep.customInstallerId },
          "Unknown customInstallerId — no implementation registered",
        );
        return {
          binary: dep.binary,
          installed: false,
          path: null,
          source: null,
          runtimeStatus: "pending",
        };
      }
      // Chromium: an install running in this process (an export's, the
      // tracker's, or a Settings click's — all one flight) is `installing`
      // with its bytes, checked BEFORE verify() because a forced Re-download
      // still has the old executable on disk while it runs. This is what
      // disables the Download / Re-download button mid-flight.
      if (dep.customInstallerId === PLAYWRIGHT_CHROMIUM_INSTALLER_ID) {
        const flight = chromiumInstallInFlight();
        if (flight) {
          return {
            binary: dep.binary,
            installed: false,
            path: null,
            source: null,
            runtimeStatus: "installing",
            ...(flight.bytesDownloaded !== undefined
              ? { bytesDownloaded: flight.bytesDownloaded, bytesTotal: flight.bytesTotal }
              : {}),
          };
        }
      }
      try {
        const p = await installer.verify();
        if (p) {
          return {
            binary: dep.binary,
            installed: true,
            path: p,
            source: "bundled",
            runtimeStatus: "installed",
          };
        }
      } catch (err) {
        logger.warn(
          { binary: dep.binary, err: err instanceof Error ? err.message : String(err) },
          "customInstaller.verify threw",
        );
      }
      const persisted = mcpId ? readDepTransition(mcpId, dep.binary) : null;
      if (persisted?.runtimeStatus === "failed") {
        return {
          binary: dep.binary,
          installed: false,
          path: null,
          source: null,
          runtimeStatus: "failed",
          error: persisted.error ?? null,
        };
      }
      return {
        binary: dep.binary,
        installed: false,
        path: null,
        source: null,
        runtimeStatus: "pending",
      };
    }
    const status = this.resolveStatus(dep);
    // Runnability gate: a binary can EXIST + match its install-token yet be
    // unable to execute (wrong CPU architecture — e.g. an x86_64 evermeet.cx
    // ffmpeg on Apple Silicon without Rosetta). `resolveStatus` only checks
    // `fs.existsSync`, so it would report a green ✔ on such a binary and the
    // install loop would skip re-fetch forever. When the dep declares a
    // `runCheck`, actually run it; a spawn failure / non-zero exit downgrades
    // the status to "pending" so the next install pass re-downloads.
    if (dep.runCheck && status.installed && status.path) {
      const runnable = await DependencyManager.isBinaryRunnable(
        status.path,
        dep.runCheck,
      );
      if (!runnable) {
        logger.warn(
          { binary: dep.binary, path: status.path, tag: "dep-runcheck" },
          "installed binary failed its runCheck (likely wrong CPU arch) — marking for re-install",
        );
        return {
          binary: dep.binary,
          installed: false,
          path: null,
          source: null,
          runtimeStatus: "pending",
        };
      }
    }
    // Capability gate: runnable is not the same as usable. A binary can execute
    // cleanly and still lack the features libi depends on — the Linux ffmpeg
    // shipped until 2026-08-16 passed `-version` and had no `drawtext`, so every
    // text overlay export failed at the ffmpeg backend. Checked AFTER runCheck
    // because an un-runnable binary cannot answer a capability probe either,
    // and "wrong CPU arch" is the more useful diagnosis when both would fail.
    if (dep.capabilityCheck && status.installed && status.path) {
      const missing = await DependencyManager.missingCapabilities(
        status.path,
        dep.capabilityCheck,
      );
      if (missing.length > 0) {
        logger.warn(
          {
            binary: dep.binary,
            path: status.path,
            missing,
            tag: "dep-capability",
          },
          `installed ${dep.binary} is missing required capabilities (${missing.join(", ")}) — marking for re-install`,
        );
        return {
          binary: dep.binary,
          installed: false,
          path: null,
          source: null,
          runtimeStatus: "pending",
        };
      }
    }
    return status;
  }

  /**
   * Execute a binary with the given args and report whether it ran cleanly
   * (exit 0). A spawn error — ENOEXEC, "bad CPU type in executable" (a
   * wrong-architecture binary), a missing dynamic dep — rejects and is caught
   * as "not runnable". Short timeout: `-version`-style probes return in
   * milliseconds; a hang means something is wrong, so treat expiry as failure.
   */
  private static async isBinaryRunnable(
    binPath: string,
    args: string[],
  ): Promise<boolean> {
    try {
      await execFileAsync(binPath, args, {
        timeout: 10_000,
        windowsHide: true,
        killSignal: "SIGKILL",
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run a capability probe and report whether the binary advertises everything
   * libi needs. See `capabilityCheck` in ./types.ts for why running is not
   * enough on its own.
   *
   * Returns the MISSING tokens rather than a bare boolean so the caller can
   * name them — "installed ffmpeg is missing: drawtext" is actionable;
   * "capability check failed" is not.
   *
   * A probe that cannot run at all reports every token missing: a binary that
   * will not answer `-filters` cannot be trusted to have those filters, and
   * `runCheck` is the thing that diagnoses un-runnable binaries.
   *
   * `maxBuffer` is raised because these probes are deliberately verbose —
   * `ffmpeg -filters` prints ~560 lines, well past the 1MB default on some
   * builds, and an overflow would otherwise read as a failed probe.
   */
  private static async missingCapabilities(
    binPath: string,
    check: { args: string[]; mustContain: string[] },
  ): Promise<string[]> {
    let output: string;
    try {
      const { stdout, stderr } = await execFileAsync(binPath, check.args, {
        timeout: 15_000,
        windowsHide: true,
        killSignal: "SIGKILL",
        maxBuffer: 8 * 1024 * 1024,
      });
      output = `${stdout}\n${stderr}`;
    } catch {
      return [...check.mustContain];
    }
    return check.mustContain.filter((token) => !output.includes(token));
  }

  /** Public for retry; called internally from ensureMcp. */
  async installMultiFile(dep: BundledDependency): Promise<void> {
    if (!dep.files || dep.files.length === 0) {
      throw new Error(`installMultiFile called on dep ${dep.binary} without files[]`);
    }
    const destRoot =
      dep.destination === "models" ? getLibiModelsDir() : getLibiBinDir();
    const destDir = path.join(destRoot, dep.binary);
    fs.mkdirSync(destDir, { recursive: true });

    // Track every file we successfully write so we can roll back atomically
    // if a later file fails. Without this, a partial install leaves orphans
    // on disk if the user doesn't retry.
    const written: string[] = [];

    try {
      for (const f of dep.files) {
        const target = path.join(destDir, f.relPath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // RC-E: HTTPS-only transport (jsdelivr / googleapis may 3xx to CDNs).
        // Task #54: stall-guarded + bounded-retry, same as downloadGroup — a
        // silent socket must fail fast with an actionable error, not hang boot.
        const buf = await downloadBufferWithStallGuard(f.url, {
          label: `${dep.binary}/${f.relPath}`,
          onRetry: ({ attempt, maxAttempts, delayMs, error, bytesDownloaded }: DownloadRetryInfo) => {
            logger.warn(
              {
                url: f.url,
                binary: dep.binary,
                relPath: f.relPath,
                attempt,
                maxAttempts,
                delayMs,
                bytesDownloaded,
                err: error.message,
              },
              "Model-file download failed — retrying",
            );
          },
        });
        fs.writeFileSync(target, buf);
        // Register for rollback BEFORE verifying so a mismatch throw unwinds it.
        written.push(target);
        // RC-E: content-verify against the pinned hash; hard-fail on mismatch.
        if (f.sha256) {
          await verifySha256(target, f.sha256);
        }
      }
    } catch (err) {
      // Roll back: any file we wrote before the failure must be deleted so
      // the next ensureAll doesn't see a partial install via existsSync.
      for (const p of written) {
        try { fs.unlinkSync(p); } catch { /* best-effort */ }
      }
      throw err;
    }

    this.writeInstallToken(dep);
  }

  private isMultiFileInstalled(dep: BundledDependency): boolean {
    if (!dep.files) return false;
    const destRoot =
      dep.destination === "models" ? getLibiModelsDir() : getLibiBinDir();
    const destDir = path.join(destRoot, dep.binary);
    const filesOk = dep.files.every((f) => fs.existsSync(path.join(destDir, f.relPath)));
    return filesOk && this.installTokenMatches(dep);
  }

  /**
   * Run a custom-installer dependency's install command. Whole-command
   * sentinels (`__ENSURE_CHROMIUM__`, `__TRACKING_PYENV_INSTALL__`,
   * `__YT_DLP_UV_INSTALL__`) dispatch to the code that owns that install;
   * anything else is spawned as declared.
   */
  private async runCustomInstaller(dep: BundledDependency): Promise<void> {
    if (!dep.customInstallerId) return;
    const installer = getCustomInstaller(dep.customInstallerId);
    if (!installer) {
      throw new Error(`Unknown customInstallerId: ${dep.customInstallerId}`);
    }
    const { command, args, timeoutMs } = installer.install;

    // Whole-command sentinel: Chromium has ONE install path,
    // `lib/export/ensure-chromium.ts` — single-flight, streamed progress,
    // its own transitions. This is how `retryDep` (the Settings Download /
    // Re-download button) and `ensureDep` (the tracker) reach it, so a click
    // during an export-driven download joins that download instead of
    // spawning a second `playwright install` behind playwright's `__dirlock`.
    // `force` only when there is something to replace: the Re-download from
    // `installed`. A first Download, a Retry from `failed`, and every
    // `ensureDep` arrive with nothing on disk and must not pass `--force`.
    if (command === ENSURE_CHROMIUM_INSTALL_SENTINEL) {
      const force = (await installer.verify()) !== null;
      // `force` is derived from what is on disk at THIS instant, which is not
      // the instant the user clicked: a click made during an export-driven
      // download becomes a forced re-download if that download finishes in
      // between. Passing when the click was accepted lets ensureChromium drop
      // a force that a completed install has already served.
      await ensureChromium({
        force,
        requestedAt: depInstallAcceptedAt(CHROMIUM_MCP_ID, CHROMIUM_DEP_BINARY),
      });
      const status = await installer.verify();
      if (!status) {
        throw new Error(
          `${dep.binary} install command completed but verify() still returns null`,
        );
      }
      logger.info(
        { binary: dep.binary, path: status, via: "ensure-chromium", force },
        "Custom installer succeeded",
      );
      return;
    }

    // Whole-command sentinel: `__TRACKING_PYENV_INSTALL__` is a multi-step
    // install (uv sync of the tracking sidecar + provisioning the ONNX
    // model artifacts). Special-cased here, mirroring __YT_DLP_UV_INSTALL__,
    // so the multi-step logic stays in installers/tracking-pyenv.ts.
    if (command === "__TRACKING_PYENV_INSTALL__") {
      const { runTrackingPyenvInstall } = await import(
        "./installers/tracking-pyenv"
      );
      await runTrackingPyenvInstall();
      const status = await installer.verify();
      if (!status) {
        throw new Error(
          `${dep.binary} install command completed but verify() still returns null`,
        );
      }
      logger.info(
        { binary: dep.binary, path: status, via: "tracking-pyenv" },
        "Custom installer succeeded",
      );
      return;
    }

    // Whole-command sentinel: `__YT_DLP_UV_INSTALL__` is a two-step install
    // (uv tool install + symlink the resulting entry point into ~/.libi/bin).
    // Special-casing it here keeps the awkwardness out of installers.ts.
    if (command === "__YT_DLP_UV_INSTALL__") {
      await this.installYtDlpViaUv(dep, timeoutMs);
      const status = await installer.verify();
      if (!status) {
        throw new Error(
          `${dep.binary} install command completed but verify() still returns null`,
        );
      }
      logger.info(
        { binary: dep.binary, path: status, via: "uv" },
        "Custom installer succeeded",
      );
      return;
    }

    logger.info(
      { binary: dep.binary, command, args },
      "Running custom installer",
    );
    await execFileAsync(command, args, {
      timeout: timeoutMs ?? 60_000,
      windowsHide: true,
      // Cap stdout/stderr — Playwright prints progress bars that can balloon.
      maxBuffer: 32 * 1024 * 1024,
    });
    const status = await installer.verify();
    if (!status) {
      throw new Error(
        `${dep.binary} install command completed but verify() still returns null`,
      );
    }
    installer.onInstalled?.(status);
    logger.info({ binary: dep.binary, path: status }, "Custom installer succeeded");
  }

  /**
   * Two-step yt-dlp install via uv:
   *   1. `uv tool install yt-dlp --python 3.12` — uv downloads
   *      python-build-standalone on first run, then installs yt-dlp into
   *      its own managed tool directory.
   *   2. Symlink the resulting `yt-dlp` entry point into `~/.libi/bin/yt-dlp`
   *      so the standard PATH augmentation (`spawn-env.ts`) makes it visible
   *      to yt-dlp-mcp.
   *
   * Looks for `uv` in `~/.libi/bin/uv` first (libi's own install) and falls
   * back to PATH if not found — matches the same resolution policy
   * `resolveStatus` uses to mark `uv` as installed (so this code can't
   * disagree with the "uv: already_installed" probe report).
   */
  private async installYtDlpViaUv(
    dep: BundledDependency,
    timeoutMs: number | undefined,
  ): Promise<void> {
    let uvBinary = this.getBinaryPath("uv");
    if (!fs.existsSync(uvBinary)) {
      // Fall back to PATH — Category A's resolveStatus marks uv "installed"
      // even when it's only on the system PATH (e.g. Homebrew). Mirror that.
      try {
        const { stdout } = await execFileAsync(
          isWindows() ? "where" : "which",
          ["uv"],
          { timeout: 5_000, windowsHide: true },
        );
        uvBinary = stdout.split("\n")[0]?.trim();
        if (!uvBinary || !fs.existsSync(uvBinary)) {
          throw new Error("uv not on PATH");
        }
      } catch {
        throw new Error(
          `Cannot install yt-dlp via uv: uv not found in ${this.getBinaryPath("uv")} or on PATH. ` +
            `ensureMcp installs a def's standard deps (uv is one, on youtube-download) ` +
            `before its custom installers, so this means the uv download itself failed — ` +
            `check the uv dep's own error.`,
        );
      }
    }

    logger.info({ binary: dep.binary, uvBinary }, "Installing yt-dlp via uv tool install");
    // --with certifi installs certifi alongside yt-dlp in the same venv.
    // We use it below to set SSL_CERT_FILE — without it, python-build-standalone
    // (uv's portable Python) has no compiled-in cert bundle and no
    // system-cert detection on macOS, so HTTPS in yt-dlp fails with
    // CERTIFICATE_VERIFY_FAILED. certifi ships Mozilla's CA bundle that
    // gets refreshed each install.
    // `--reinstall` (implies `--refresh`) forces uv to fetch and install the
    // CURRENT upstream yt-dlp even when a previous version is already present —
    // without it, `uv tool install` no-ops on an existing install and users
    // stay pinned to a stale binary forever. verify() gates this to run only
    // when YT_DLP_UV_TOKEN was bumped (or on a fresh install), so it's not
    // per-boot churn.
    await execFileAsync(
      uvBinary,
      // The requirement carries the `[default]` extra — the yt-dlp-ejs
      // JS-challenge solver. See `YT_DLP_UV_REQUIREMENT` for what happens
      // without it (throttled, then 403 mid-download).
      ytDlpUvInstallArgs(),
      {
        timeout: timeoutMs ?? 5 * 60_000,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        // Pins UV_TOOL_DIR / UV_TOOL_BIN_DIR / UV_CACHE_DIR /
        // UV_PYTHON_INSTALL_DIR under LIBI_HOME so the tool venv and the
        // managed CPython it pulls land in libi's own tree rather than
        // `~/.local/share/uv`. The `uv tool dir` probe below uses the same
        // env, so entry-point discovery follows the relocation automatically.
        env: buildUvEnv(),
      },
    );

    // Discover where uv put it. Strip ANSI color escape sequences — uv emits
    // them via its `colored` config even with stdio piped from Node, and they
    // corrupt the path otherwise (`[36m/path[39m`).
    const { stdout: toolDirStdout } = await execFileAsync(uvBinary, ["tool", "dir"], {
      timeout: 10_000,
      windowsHide: true,
      env: buildUvEnv({ NO_COLOR: "1" }),
    });
    // eslint-disable-next-line no-control-regex
    const toolDir = toolDirStdout.replace(/\[[0-9;]*m/g, "").trim();
    // A uv/PEP-405 venv puts entry points in `Scripts\` on Windows and `bin/`
    // everywhere else. Getting the FILENAME right (.exe) but not the DIRECTORY
    // meant this threw "expected entry point not found" on every Windows boot —
    // and because yt-dlp is a tier-1 dep whose failure is fatal to Category A,
    // that took the whole app down before it ever served a page.
    const venvBinDir = isWindows() ? "Scripts" : "bin";
    const ytDlpEntry = path.join(
      toolDir,
      "yt-dlp",
      venvBinDir,
      `yt-dlp${exeSuffix()}`,
    );
    if (!fs.existsSync(ytDlpEntry)) {
      throw new Error(
        `uv tool install completed but expected entry point not found: ${ytDlpEntry}`,
      );
    }

    // Locate the uv-managed Python's certifi CA bundle. yt-dlp depends on
    // certifi (it's pulled in transitively), so it's installed in the same
    // venv. We use it to set SSL_CERT_FILE — without it, Python's ssl
    // module on macOS can't find system root CAs and YouTube downloads
    // fail with CERTIFICATE_VERIFY_FAILED.
    const pythonBin = path.join(
      toolDir,
      "yt-dlp",
      venvBinDir,
      isWindows() ? "python.exe" : "python3",
    );
    let certifiPath = "";
    try {
      const { stdout } = await execFileAsync(pythonBin, ["-m", "certifi"], {
        timeout: 10_000,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1" },
      });
      certifiPath = stdout.replace(/\[[0-9;]*m/g, "").trim();
      if (!fs.existsSync(certifiPath)) certifiPath = "";
    } catch {
      // certifi might not be exposed — fall back to no SSL_CERT_FILE.
      // yt-dlp may still work if Python finds certs another way.
    }

    const wrapperPath = path.join(getLibiBinDir(), "yt-dlp");
    // Clear any stale symlink/file first. unlink works for both regular files
    // and symlinks; we ignore ENOENT.
    try {
      fs.unlinkSync(wrapperPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    if (isWindows()) {
      // Windows: shim via .cmd. Symlinks on Windows require admin in many
      // setups, so a small .cmd wrapper is simpler. yt-dlp-mcp resolves
      // `yt-dlp` on PATH which finds .cmd extensions via PATHEXT.
      const cmdPath = wrapperPath + ".cmd";
      try {
        fs.unlinkSync(cmdPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      const certLine = certifiPath
        ? `set SSL_CERT_FILE=${certifiPath}\r\nset REQUESTS_CA_BUNDLE=${certifiPath}\r\n`
        : "";
      // See the Unix branch: inject --no-playlist unless a playlist flag is
      // already present, so a Radio/Mix URL can't hang the single-video tools.
      const guard =
        `echo %*| findstr /I /C:"playlist" >nul\r\n` +
        `if errorlevel 1 (\r\n` +
        `  "${ytDlpEntry}" --no-playlist %*\r\n` +
        `) else (\r\n` +
        `  "${ytDlpEntry}" %*\r\n` +
        `)\r\n`;
      fs.writeFileSync(cmdPath, `@echo off\r\n${certLine}${guard}`);
      logger.info(
        { binary: dep.binary, ytDlpEntry, wrapperPath: cmdPath, hasCertifi: !!certifiPath },
        "Wrote yt-dlp.cmd wrapper into ~/.libi/bin",
      );
    } else {
      // Unix: shell wrapper that exports SSL_CERT_FILE then execs the real
      // binary. exec replaces this process so signals/exit codes pass through.
      const certLine = certifiPath
        ? `export SSL_CERT_FILE="${certifiPath}"\nexport REQUESTS_CA_BUNDLE="${certifiPath}"\n`
        : "";
      // Default to single-video mode: inject --no-playlist unless the caller
      // ALREADY passes a playlist flag (the yt-dlp-mcp search tool uses
      // --flat-playlist). Without this, a YouTube Radio/Mix URL
      // (watch?v=…&list=RD…&start_radio=1) makes the single-video
      // metadata/download tools enumerate an effectively endless auto-playlist
      // and hang past the MCP's 120s tool timeout — the fix an agent won't
      // reliably apply by canonicalizing the URL itself. --no-playlist is the
      // correct default for those tools (they parse ONE video) and a no-op on
      // plain watch?v= URLs; the *playlist* guard keeps search untouched.
      const script =
        `#!/bin/bash\n` +
        `# Generated by libi DependencyManager.installYtDlpViaUv\n` +
        `${certLine}` +
        `for _a in "$@"; do case "$_a" in *playlist*) exec "${ytDlpEntry}" "$@";; esac; done\n` +
        `exec "${ytDlpEntry}" --no-playlist "$@"\n`;
      fs.writeFileSync(wrapperPath, script, { mode: 0o755 });
      logger.info(
        { binary: dep.binary, ytDlpEntry, wrapperPath, hasCertifi: !!certifiPath },
        "Wrote yt-dlp wrapper into ~/.libi/bin with SSL_CERT_FILE from uv's certifi",
      );
    }

    // Stamp the install token so verify() reports installed until the next
    // YT_DLP_UV_TOKEN bump. Written last, after the wrapper is in place, so a
    // mid-install crash leaves no token and the next boot re-installs.
    fs.writeFileSync(ytDlpTokenPath(getLibiBinDir()), YT_DLP_UV_TOKEN, "utf-8");
  }

  private binaryExistsOnPath(binary: string): boolean {
    try {
      const cmd = isWindows() ? "where" : "which";
      execSync(`${cmd} ${binary}`, { stdio: "ignore", timeout: 3000, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }

  private getBinaryPath(binary: string): string {
    // exeSuffix(), not `process.platform === "win32"` — see lib/platform.ts.
    // The Next build folds that comparison against the BUILD machine, which is
    // how the shipped server came to look for `bin/uv` while Category A (built
    // by esbuild, which does not fold) had written `bin/uv.exe`.
    const name = `${binary}${exeSuffix()}`;
    return path.join(getLibiBinDir(), name);
  }

  /**
   * Path of the install-token marker file for a dep.
   *
   * For `files[]` deps the marker lives inside the per-dep directory at
   * `.install-token`. For raw-binary / archive deps it sits next to the
   * binary in `~/.libi/bin/` as `<binary>.install-token`. Custom-installer
   * deps have no marker — they're versioned by their upstream installer
   * (e.g. playwright keys chromium by revision against package.json).
   */
  private getInstallTokenPath(dep: BundledDependency): string | null {
    if (dep.customInstallerId) return null;
    if (dep.files) {
      const root = dep.destination === "models" ? getLibiModelsDir() : getLibiBinDir();
      return path.join(root, dep.binary, ".install-token");
    }
    return `${this.getBinaryPath(dep.binary)}.install-token`;
  }

  /** Read the marker; null when missing or unreadable. */
  private readInstallToken(dep: BundledDependency): string | null {
    const p = this.getInstallTokenPath(dep);
    if (!p) return null;
    try {
      return fs.readFileSync(p, "utf-8").trim();
    } catch {
      return null;
    }
  }

  /** Write `dep.pinnedInstallToken` to the marker; no-op when unset. */
  private writeInstallToken(dep: BundledDependency): void {
    if (!dep.pinnedInstallToken) return;
    const p = this.getInstallTokenPath(dep);
    if (!p) return;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, dep.pinnedInstallToken, "utf-8");
    } catch (err) {
      logger.warn(
        { binary: dep.binary, err: err instanceof Error ? err.message : String(err) },
        "Failed to write install-token marker — re-installs will retrigger until fixed",
      );
    }
  }

  /**
   * True when the dep declares a `pinnedInstallToken` AND the on-disk
   * marker exists AND matches. False on missing marker or content
   * mismatch. Returns true when no token is declared (nothing to
   * enforce). Drives the re-install decision in resolveStatus.
   */
  private installTokenMatches(dep: BundledDependency): boolean {
    if (!dep.pinnedInstallToken) return true;
    const marker = this.readInstallToken(dep);
    return marker === dep.pinnedInstallToken;
  }

  /**
   * Download a single URL that will satisfy one or more binary dependencies.
   * If the URL is a raw binary (no `archive`), the group must contain exactly
   * one dep. If it's an archive, each dep is extracted using its own
   * `binaryPathInArchive` mapping.
   */
  /**
   * Internal progress callback type for downloadGroup. Uses a simplified shape
   * since mcpId/binary are added by the caller before forwarding to the public
   * BinaryInstallProgressCallback.
   */
  private async downloadGroup(
    url: string,
    deps: BundledDependency[],
    onProgress?: (p: Pick<BinaryInstallProgress, "status" | "bytesDownloaded" | "bytesTotal" | "detail">) => void,
  ): Promise<void> {
    const binaries = deps.map((d) => d.binary);
    const label = binaries.join(", ");
    logger.info({ url, binaries }, "Downloading dependency");
    // Task #54: stall-guarded download. The transport is still
    // `fetchWithHttpsOnlyRedirects` (RC-E: manual redirects, HTTPS-only), but
    // wrapped with an IDLE deadline (re-armed on every chunk — a slow but
    // progressing download is never killed), bounded retries with backoff,
    // and a terminal error that names host + url + dependency + bytes. This
    // replaced a bare fetch + unbounded `reader.read()` loop that hung the
    // packaged first boot FOREVER when the socket went silent mid-stream.
    const buffer = await downloadBufferWithStallGuard(url, {
      label,
      onProgress: onProgress
        ? (p) => onProgress({ status: "downloading", ...p })
        : undefined,
      onRetry: ({ attempt, maxAttempts, delayMs, error, bytesDownloaded, bytesTotal }: DownloadRetryInfo) => {
        logger.warn(
          {
            url,
            binaries,
            attempt,
            maxAttempts,
            delayMs,
            bytesDownloaded,
            err: error.message,
          },
          "Dependency download failed — retrying",
        );
        const why = error instanceof DownloadStalledError ? "stalled" : "failed";
        onProgress?.({
          status: "downloading",
          bytesDownloaded: 0,
          bytesTotal,
          detail: `download ${why} — retrying (attempt ${attempt + 1} of ${maxAttempts})`,
        });
      },
    });

    const isArchive = deps.some((d) => d.archive !== undefined);
    if (!isArchive) {
      // Raw binary — single dep only.
      if (deps.length !== 1) {
        throw new Error("Raw-binary URL shared across multiple deps");
      }
      const dep = deps[0];
      const binPath = this.getBinaryPath(dep.binary);
      fs.writeFileSync(binPath, buffer);
      // RC-E: verify (pinned sha) or warn (latest-alias) BEFORE chmod + token.
      await this.verifyBinaryIntegrity(dep, binPath);
      if (!isWindows()) fs.chmodSync(binPath, 0o755);
      this.writeInstallToken(dep);
      logger.info({ binary: dep.binary, path: binPath }, "Dependency installed");
      return;
    }

    // Archive: write to temp, extract, move each requested binary.
    onProgress?.({ status: "extracting" });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-dep-"));
    try {
      const archiveName = this.archiveFilenameFor(url, deps);
      const archivePath = path.join(tmpDir, archiveName);
      fs.writeFileSync(archivePath, buffer);

      await this.extractArchive(archivePath, tmpDir);

      for (const dep of deps) {
        if (!dep.archive) continue;
        const pattern = DependencyManager.resolveBinaryPathInArchive(dep);
        const extracted = resolveGlob(tmpDir, pattern);
        if (!extracted) {
          throw new Error(`Extracted file not found for ${dep.binary}: ${pattern}`);
        }
        const destPath = this.getBinaryPath(dep.binary);
        fs.copyFileSync(extracted, destPath);
        // RC-E: verify (pinned sha) or warn (latest-alias) BEFORE chmod + token.
        await this.verifyBinaryIntegrity(dep, destPath);
        if (!isWindows()) fs.chmodSync(destPath, 0o755);
        this.writeInstallToken(dep);
        logger.info({ binary: dep.binary, path: destPath }, "Dependency installed");
      }
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }

  private archiveFilenameFor(url: string, deps: BundledDependency[]): string {
    // Use the first dep's archive format; both ffmpeg/ffprobe share one archive on Linux/Windows.
    const format = deps[0].archive?.format ?? "zip";
    return format === "tar.xz" ? "archive.tar.xz" : "archive.zip";
  }

  private async extractArchive(archivePath: string, destDir: string): Promise<void> {
    // Modern macOS/Linux/Win10+ all ship with `tar` that handles both zip and tar.xz.
    await execFileAsync("tar", ["-xf", archivePath, "-C", destDir], { timeout: 60_000, windowsHide: true });
  }

}
