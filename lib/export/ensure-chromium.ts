// lib/export/ensure-chromium.ts
//
// Chromium is ~173 MB that only a canvas export needs. It used to be a tier-1
// dependency of the `libi` core def, so EVERY user paid for it before the editor
// opened — including the majority who only ever trim and stitch video, which the
// ffmpeg backends handle without a browser. It now downloads inside the first
// export whose classifier picks `chromium-render` (and before the first
// tracker launch, which needs the same browser — `lib/tracking/mediapipe-runner.ts`),
// or from the Download / Re-download button on the `libi-export` row in Settings.
//
// This is THE install path for the chromium dep — the only place that spawns
// `playwright install`. `DependencyManager.retryDep` / `ensureDep` (the Settings
// button, the tracker) reach it through the `playwright-chromium` installer's
// sentinel (`mcp/registry/installers.ts` → `runCustomInstaller`). It used to
// have a second spawn site of its own, `execFileAsync` with a 32 MB buffer, which
// (a) threw Playwright's progress lines away, so the Settings chip never showed
// bytes, and (b) ran OUTSIDE this file's single-flight, so a Settings click during
// an export-driven download queued a second `playwright install … --force`
// behind playwright-core's `__dirlock` and then force-removed the revision the
// finished export was about to launch. One spawn, one flight, one set of
// `dependencyStatus` transitions (plus bytes) — and `chromiumInstallInFlight()`
// so `DependencyManager.getStatuses` can report the flight as `installing`.
import { execFile, spawn } from "node:child_process";

import { exportLogger as logger } from "@/lib/logger";
import { getCustomInstaller } from "@/mcp/registry/installers";
import { writeDepTransition } from "@/mcp/registry/dep-transition";
import { resolvePlaywrightCoreCli } from "@/lib/playwright/paths";
import { resolveNodeCommand } from "@/lib/runtime/node-runtime";
import { CHROMIUM_DOWNLOAD_MB, CHROMIUM_DOWNLOAD_MIB, mibToMb } from "@/lib/export/chromium-size";

export { CHROMIUM_DOWNLOAD_MB, CHROMIUM_DOWNLOAD_MIB, mibToMb };

/** The bundled def + dep this installs. Both strings come verbatim from
 *  `mcp/registry/bundled.ts` so the Settings row and this code cannot drift. */
export const CHROMIUM_MCP_ID = "libi-export";
export const CHROMIUM_DEP_BINARY = "chromium";

/** 10 min, matching the installer declaration this runs on behalf of
 *  (`mcp/registry/installers.ts`, `timeoutMs: 10 * 60_000`). */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

const CUSTOM_INSTALLER_ID = "playwright-chromium";

/** `node --version` is instant; this only bounds a wedged binary. */
const NODE_VERSION_PROBE_TIMEOUT_MS = 5_000;

/** Is a launchable Chromium already on disk? Delegates to the installer's own
 *  `verify()` so there is exactly one definition of "installed". */
export async function chromiumInstalled(): Promise<boolean> {
  const installer = getCustomInstaller(CUSTOM_INSTALLER_ID);
  if (!installer) return false;
  return (await installer.verify()) !== null;
}

/**
 * One line of Playwright's NON-TTY download progress, or null.
 *
 * `browserFetcher.js` (`getBasicDownloadProgress`) emits, once per 10% step:
 *
 *   `|` + "■"*(row*8) + " "*((10-row)*8) + `| ` + percent.padStart(3) + `% of ` + `${mib} MiB`
 *
 * `process.stdout.isTTY` is false for a spawned child, so this is the branch we
 * get (`getDownloadProgress`). Deliberately strict: a loose regex over
 * Playwright's stdout would also match its "Downloading …" banner and report
 * nonsense percentages. The run of spaces after the closing pipe is 1..3: the
 * literal space plus `padStart(3)` — three before `0%`, two before `50%`, one
 * before `100%`. Capping it at two (an earlier draft did) drops the first tick
 * of every download, and the parser test would not notice unless it fed the
 * real 0% line.
 *
 * `totalMb` is DECIMAL megabytes: Playwright's MiB figure converted here, at
 * the boundary, so nothing downstream ever sees a MiB labelled "MB".
 */
export function parsePlaywrightProgressLine(
  line: string,
): { percent: number; totalMb: number } | null {
  const m = /^\|[■ ]{80}\|\s{1,3}(\d{1,3})% of ([\d.]+) MiB\s*$/.exec(line);
  if (!m) return null;
  const percent = Number(m[1]);
  const totalMib = Number(m[2]);
  if (!Number.isFinite(percent) || !Number.isFinite(totalMib)) return null;
  return { percent, totalMb: mibToMb(totalMib) };
}

export interface ChromiumDownloadProgress {
  doneMb: number;
  totalMb: number;
}

export interface EnsureChromiumOptions {
  /** Called on each parsed progress line. `totalMb` is Playwright's own figure, in MB. */
  onProgress?: (p: ChromiumDownloadProgress) => void;
  /** Polled between lines; true kills the child and rejects. */
  shouldCancel?: () => boolean;
  /** Also kills the child on abort — the export runner already has one. */
  signal?: AbortSignal;
  /**
   * Replace an existing install: skips the on-disk short-circuit and passes
   * `--force` to `playwright install`, which otherwise sees an executable,
   * prints its ATTENTION box and returns 0 without touching the disk
   * (playwright-core/lib/server/registry/index.js). Only the Settings
   * Re-download passes this — an export or tracker never does. A forced call
   * arriving while a plain download is already running JOINS that download:
   * the result is a fresh Chromium either way, and a second `--force` would
   * queue behind playwright's `__dirlock` and then delete what just landed.
   *
   * The same reasoning covers the moments just AFTER a flight ends: see
   * `requestedAt`.
   */
  force?: boolean;
  /**
   * When the request behind this call was accepted (the retry-dep route's
   * `markDepInstalling` stamp). Only meaningful with `force`.
   *
   * `DependencyManager.runCustomInstaller` derives `force` from a fresh
   * `installer.verify()` — "is something on disk RIGHT NOW". A Settings click
   * made while an export-driven download was running is `force: false` and
   * joins that download; but if the download finishes in the moments between
   * the click and the verify, the SAME click becomes `force: true`, finds no
   * flight to join, and starts a second full 173 MB download of the Chromium
   * that landed a second ago.
   *
   * An install that completed after `requestedAt` has already given that
   * request what it asked for, so the force is dropped. A Re-download clicked
   * later is stamped later and still forces — no time window, no guessing.
   * Omit it (an export, the tracker, Category A) and nothing changes.
   */
  requestedAt?: number;
}

/** What `chromiumInstallInFlight()` reports: the last persisted tick's bytes,
 *  or neither field before the first tick. */
export interface ChromiumInstallSnapshot {
  bytesDownloaded?: number;
  bytesTotal?: number;
}

/**
 * The one download in flight, if any. Export and tracking are separate job
 * kinds with `maxConcurrent: 1` EACH, and the Settings button is a third
 * caller, so `ensureChromium` calls overlap. Without this, the second would
 * spawn a second `playwright install` — and playwright-core's `__dirlock`
 * (registry/index.js) makes the loser block silently until the winner
 * finishes, i.e. until our 10-minute timeout fires, whose `failed` transition
 * would then overwrite the winner's `installed`. So: one child, and every
 * concurrent caller awaits it and receives its ticks through their own
 * `onProgress` (fan-out).
 *
 * There is NO owner. Every caller — including the one whose call started the
 * flight — is a participant: its own cancel (signal / shouldCancel) detaches
 * it and rejects only its promise, and the child is killed when the LAST
 * participant leaves. It used to be asymmetric, with the starter's cancel
 * killing the child and failing every waiter, so a Settings download that had
 * merely joined an export's flight reported "chromium install cancelled"
 * because someone else's job was stopped. The 10-minute timeout is
 * flight-wide and still fails everyone — that one really is everyone's
 * problem.
 */
interface InFlightInstall {
  promise: Promise<void>;
  subscribers: Set<(p: ChromiumDownloadProgress) => void>;
  /** Replayed to a late joiner so its bar is not blank until the next 10% step. */
  last: ChromiumDownloadProgress | null;
  /** The same tick in bytes — what the Settings chip's percentage is built from. */
  lastBytes: ChromiumInstallSnapshot | null;
  /** Callers still waiting on this flight. The child is killed only when this
   *  empties — see `joinInFlight`. */
  participants: Set<symbol>;
  /** Kills the child, set once `install` has spawned one. */
  killChild: ((err: Error) => void) | null;
  /** Set when every participant has detached before the child existed, so the
   *  spawn is skipped rather than started for nobody. */
  cancelled: Error | null;
  /** `--force` was requested by the caller that STARTED the flight. */
  force: boolean;
}

let inFlight: InFlightInstall | null = null;

/** When the last install in this process finished successfully — the other
 *  half of `EnsureChromiumOptions.requestedAt`. */
let lastInstallCompletedAt = 0;

/** Tests only — this timestamp is process-global by design. */
export function _resetChromiumInstallState(): void {
  inFlight = null;
  lastInstallCompletedAt = 0;
}

/**
 * The install running in THIS process, or null. `DependencyManager.getStatuses`
 * reports the chromium dep as `installing` (with these bytes) while this is
 * non-null — in-process state rather than the persisted `installing`
 * transition on its own, because a crash mid-download would leave that
 * transition behind forever, whereas a restart has no flight and reads the
 * disk (cf. `lib/mcp-virtual-deps/in-flight.ts`, the same trade for the
 * virtual deps).
 */
export function chromiumInstallInFlight(): ChromiumInstallSnapshot | null {
  if (!inFlight) return null;
  return inFlight.lastBytes ? { ...inFlight.lastBytes } : {};
}

/**
 * Ensure a launchable Chromium, downloading it with byte progress if absent
 * (or regardless, with `force`). Resolves immediately when it is already
 * there; joins the install already running when there is one.
 */
export function ensureChromium(opts: EnsureChromiumOptions = {}): Promise<void> {
  if (inFlight) return joinInFlight(inFlight, opts);

  // An install that finished AFTER this request was made has already served
  // it — the request just arrived here late enough to have become a `force`.
  // See `EnsureChromiumOptions.requestedAt`.
  if (opts.force && opts.requestedAt !== undefined && lastInstallCompletedAt > opts.requestedAt) {
    logger.info(
      {
        tag: "export",
        op: "ensure_chromium_force_coalesced",
        requestedAt: opts.requestedAt,
        completedAt: lastInstallCompletedAt,
      },
      "export.ensure_chromium_force_coalesced",
    );
    return Promise.resolve();
  }

  // The flight starts HERE, before the on-disk check, so a caller arriving
  // while `verify()` is on the event loop joins it too and sees every tick —
  // not only the ones after it happened to look.
  const flight: InFlightInstall = {
    promise: Promise.resolve(),
    subscribers: new Set(),
    last: null,
    lastBytes: null,
    participants: new Set(),
    killChild: null,
    cancelled: null,
    force: opts.force === true,
  };
  flight.promise = (async () => {
    if (!flight.force && (await chromiumInstalled())) return;
    await install(flight);
  })().finally(() => {
    if (inFlight === flight) inFlight = null;
  });
  // Nobody may be left waiting on it (every participant can detach), so the
  // flight's own rejection must not surface as an unhandled rejection. Each
  // participant still gets the real error through its own `joinInFlight`.
  flight.promise.catch(() => {});
  inFlight = flight;
  return joinInFlight(flight, opts);
}

/**
 * Attach one caller to a flight: its progress sink, its cancellation, its
 * promise. The caller that STARTED the flight goes through here too, so there
 * is no owner — which is the point.
 *
 * Cancellation is refcounted. It used to be asymmetric: the
 * starter's cancel killed the child and failed every waiter, so a Settings
 * download that merely joined an export's flight reported "chromium install
 * cancelled" because someone else's job was stopped. Now a cancel detaches
 * only that caller, and the child is killed when the LAST one leaves — which
 * for a single caller is the same behaviour as before, and for several is the
 * one that does not lie to the others.
 */
function joinInFlight(flight: InFlightInstall, opts: EnsureChromiumOptions): Promise<void> {
  const { onProgress } = opts;
  if (onProgress) {
    flight.subscribers.add(onProgress);
    if (flight.last) onProgress(flight.last);
  }
  const me = Symbol("chromium-install-participant");
  flight.participants.add(me);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearInterval(cancelPoll);
      opts.signal?.removeEventListener("abort", onAbort);
      if (onProgress) flight.subscribers.delete(onProgress);
      flight.participants.delete(me);
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => {
      const err = new Error("chromium install cancelled");
      finish(err);
      // Last one out kills the child. While anyone is still waiting, the
      // download carries on for them.
      if (flight.participants.size === 0) {
        flight.cancelled = err;
        flight.killChild?.(err);
      }
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const cancelPoll = setInterval(() => {
      if (opts.shouldCancel?.()) onAbort();
    }, 500);
    cancelPoll.unref?.();
    flight.promise.then(
      () => finish(null),
      (err: Error) => finish(err),
    );
  });
}

/** Successful probes only — a failed one is retried on the next flight. */
const spawnedNodeVersions = new Map<string, string>();

/**
 * The version of the node that actually runs the CLI. NOT `process.version`:
 * the child is spawned with `resolveNodeCommand()`, which under the packaged
 * app is `<LIBI_HOME>/bin/node` while this process is Electron's Node, and the
 * one known hang (24.16.0's extractor) is a property of the spawned one. Falls
 * back to this process's version marked `(host)` so a support thread can tell
 * the two apart.
 */
async function spawnedNodeVersion(command: string): Promise<string> {
  const cached = spawnedNodeVersions.get(command);
  if (cached) return cached;
  const probed = await new Promise<string | null>((resolve) => {
    try {
      execFile(
        command,
        ["--version"],
        { timeout: NODE_VERSION_PROBE_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          const version = err ? "" : String(stdout).trim();
          resolve(/^v\d+\.\d+\.\d+/.test(version) ? version : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
  if (!probed) return `${process.version} (host)`;
  spawnedNodeVersions.set(command, probed);
  return probed;
}

/** Tests only: the cache is per process and the tests stub the probe. */
export function _resetSpawnedNodeVersionCache(): void {
  spawnedNodeVersions.clear();
}

function timeoutMessage(nodeVersion: string): string {
  const minutes = INSTALL_TIMEOUT_MS / 60_000;
  return (
    `Chromium download did not finish within ${minutes} min (Node ${nodeVersion}). ` +
    "Known cause: Node 24.16.0 hangs Playwright's extractor — use Node 24.18.0 or newer, " +
    "then retry the download under Settings → Canvas export (Chromium)."
  );
}

type FailureReason = "timeout" | "cancelled" | "spawn" | "exit" | "verify";

async function install(flight: InFlightInstall): Promise<void> {
  // Every participant left before the child was even spawned.
  if (flight.cancelled) throw flight.cancelled;
  writeDepTransition(CHROMIUM_MCP_ID, CHROMIUM_DEP_BINARY, {
    runtimeStatus: "installing",
    error: null,
  });

  // A REAL node — never `process.execPath`. Under the packaged app that is the
  // Electron binary, and `electronFuses.runAsNode: false` makes it ignore
  // ELECTRON_RUN_AS_NODE, so spawning it launches a second Libi GUI instead of
  // Playwright's CLI. Resolved HERE, at install time, so it picks up
  // `<LIBI_HOME>/bin/node` once Category A has provisioned it.
  const command = resolveNodeCommand();
  // `--no-shell`: `playwright install chromium` fetches TWO archives by default
  // — chromium AND chromium-headless-shell. Both libi launch sites pass
  // `channel: "chromium"` (the shell ships without WebCodecs), so the shell
  // would be ~80 MB downloaded and never executed. `--force` only for the
  // Settings Re-download — see `EnsureChromiumOptions.force`.
  const args = [
    resolvePlaywrightCoreCli(),
    "install",
    "chromium",
    "--no-shell",
    ...(flight.force ? ["--force"] : []),
  ];
  const nodeVersion = await spawnedNodeVersion(command);

  const startedAt = Date.now();
  // Set from the child's `close` event; null while it is still running (or
  // when it never spawned), so a timeout / cancel failure is logged without it.
  // (A holder rather than a `let`: TypeScript does not see assignments made
  // inside the `close` callback and would narrow a bare `let` to `null`.)
  const exit: { value: { code: number | null; signal: NodeJS.Signals | null } | null } = {
    value: null,
  };

  const fail = (reason: FailureReason, err: Error): never => {
    writeDepTransition(CHROMIUM_MCP_ID, CHROMIUM_DEP_BINARY, {
      runtimeStatus: "failed",
      error: err.message,
    });
    // Every rejection is logged with what a support thread needs first: which
    // node ran the CLI and how long it took. The 24.16.0 extractor hang was
    // found by hand from a bare "timed out" — this makes it one grep.
    logger.warn(
      {
        tag: "export",
        op: "ensure_chromium_failed",
        reason,
        elapsedMs: Date.now() - startedAt,
        nodeVersion,
        command,
        exitCode: exit.value?.code ?? null,
        signal: exit.value?.signal ?? null,
        error: err.message,
      },
      "export.ensure_chromium_failed",
    );
    throw err;
  };

  logger.info(
    { tag: "export", op: "ensure_chromium_start", command, args, nodeVersion },
    "export.ensure_chromium_start",
  );

  const emit = (p: ChromiumDownloadProgress) => {
    flight.last = p;
    for (const subscriber of flight.subscribers) subscriber(p);
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        // Same reason as `lib/agents/process-manager.ts`: under the packaged
        // app the parent is a GUI-subsystem process, so on Windows every
        // console-subsystem child would otherwise get a console window of
        // its own for the length of the download.
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let settled = false;
      let stderrTail = "";
      const finish = (err: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        flight.killChild = null;
        if (err) reject(err);
        else resolve();
      };
      const kill = (err: Error) => {
        // This SIGKILL reaches only the CLI (`cli.js`). The download and the
        // zip extraction run in a GRANDCHILD: `browserFetcher.js`
        // (`downloadBrowserWithProgressBarOutOfProcess`) does a
        // `childProcess.fork("oopDownloadBrowserMain.js")` and talks to it
        // over IPC. Killing the CLI closes that IPC channel, and the grandchild
        // handles it — `process.on("disconnect", () => process.exit(0))` in
        // oopDownloadBrowserMain.js — so cancellation depends on that handler,
        // not on any signal of ours reaching the grandchild. Same on Windows:
        // `kill("SIGKILL")` is TerminateProcess on the CLI, the IPC pipe
        // closes with it, and the grandchild takes the same `disconnect`
        // exit. Verified against playwright-core 1.59.1.
        child.kill("SIGKILL");
        finish(err);
      };

      const timer = setTimeout(
        () => kill(new Error(timeoutMessage(nodeVersion))),
        INSTALL_TIMEOUT_MS,
      );
      timer.unref?.();
      // Cancellation reaches the child ONLY through the flight: each caller's
      // own `signal` / `shouldCancel` detaches that caller in `joinInFlight`,
      // and the last one to leave calls this. A per-caller kill here is what
      // made one job's cancel fail every other waiter.
      flight.killChild = kill;
      // Lost the race with the last participant's cancel — it had nothing to
      // kill when it fired, so honour it now rather than downloading 173 MB
      // for nobody.
      if (flight.cancelled) kill(flight.cancelled);

      // Progress goes to STDOUT via console.log (browserFetcher.js); the
      // "Downloading …" banner does too (logPolitely). stderr carries
      // Playwright's ATTENTION box and any real failure, so keep a tail of it for
      // the error message.
      let buf = "";
      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const parsed = parsePlaywrightProgressLine(line);
          if (!parsed) continue;
          // Bytes are the source of truth (the parser's MB is exact, not
          // rounded); the MB shown to the user are rounded from them.
          const totalBytes = Math.round(parsed.totalMb * 1_000_000);
          const doneBytes = Math.round((parsed.percent / 100) * totalBytes);
          flight.lastBytes = { bytesDownloaded: doneBytes, bytesTotal: totalBytes };
          emit({
            doneMb: Math.round(doneBytes / 1_000_000),
            totalMb: Math.round(totalBytes / 1_000_000),
          });
          // Eleven lines per archive — cheap enough to persist each one, and it
          // is what turns the Settings chip's spinner into a percentage.
          writeDepTransition(CHROMIUM_MCP_ID, CHROMIUM_DEP_BINARY, {
            runtimeStatus: "installing",
            bytesDownloaded: doneBytes,
            bytesTotal: totalBytes,
          });
        }
      });
      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-4000);
      });

      child.on("error", (err) => finish(err));
      child.on("close", (code, signal) => {
        exit.value = { code, signal };
        if (code === 0) finish(null);
        else finish(new Error(`playwright install chromium exited ${code}: ${stderrTail.trim()}`));
      });
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const reason: FailureReason = exit.value
      ? "exit"
      : error.message === "chromium install cancelled"
        ? "cancelled"
        : error.message.startsWith("Chromium download did not finish")
          ? "timeout"
          : "spawn";
    return fail(reason, error);
  }

  // VERIFY BEFORE DECLARING SUCCESS. A zero exit only means the CLI did not
  // throw; the installer's own `verify()` is the evidence.
  const installer = getCustomInstaller(CUSTOM_INSTALLER_ID);
  const executable = installer ? await installer.verify() : null;
  if (!executable) {
    return fail(
      "verify",
      new Error(
        "playwright install chromium exited 0 but chromium.executablePath() still does not exist",
      ),
    );
  }
  // Stamps the revision dir `.libi-installed` so the boot prune may reclaim
  // it once playwright-core moves on.
  installer?.onInstalled?.(executable);
  writeDepTransition(CHROMIUM_MCP_ID, CHROMIUM_DEP_BINARY, {
    runtimeStatus: "installed",
    installed: true,
    path: executable,
    source: "bundled",
    error: null,
  });
  // A `force` arriving in the next few seconds is this install's own click
  // arriving late — see FORCE_COALESCE_MS. Stamped only on a real, verified
  // install: the on-disk short-circuit downloaded nothing and must not
  // suppress a Re-download.
  lastInstallCompletedAt = Date.now();
  logger.info(
    { tag: "export", op: "ensure_chromium_done", executable, elapsedMs: Date.now() - startedAt },
    "export.ensure_chromium_done",
  );
}
