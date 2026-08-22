// electron/shell-updater.ts
//
// The SHELL's own update channel: electron-updater against libi's GitHub
// Releases feed (`publish:` in electron-builder.yml, which also emits the
// `app-update.yml` this reads its config from). This is the rare cadence —
// Chromium CVEs, native ABI bumps, `shellApiVersion` breaks; the weekly
// cadence is the npm runtime and never comes through here (docs-local/from-repo/RELEASING.md).
//
// The UI lives in the runtime's Next server, so this file's job is to wrap
// electron-updater in the small `ShellUpdater` bridge the runtime defines
// (`lib/runtime/shell-update.ts`) and keep a status snapshot the update
// route can poll. Two behavioural rules, matching the runtime channel's
// auto-download flow:
//
//  * **Downloads are automatic — unless the install can't apply one.** With
//    `autoDownload` on, finding an update IS starting its download, so the
//    "can this bundle be replaced?" question has to be answered BEFORE the
//    check, not after 481 MB (`self-update-probe.ts` for the whole story).
//    A blocked install turns `autoDownload` off, downloads nothing, and
//    reports `phase: "blocked"` so the UI can say why. The user is never
//    asked to approve a download — only a restart.
//  * **Restarts are explicit.** A verified download parks at `ready` and
//    stays there until the UI's "Restart to apply" calls `restart()` — or
//    the user quits normally and `autoInstallOnAppQuit` applies it on the
//    way out. The one exception is a `download()` call arriving when the
//    download is already ready: that is an OLD runtime's "Install & restart"
//    click, whose UI promises an immediate restart, so honor it.
//
// Failures are status, not dialogs: `phase: "error"` renders as nothing,
// exactly like the npm check's `unknown` — a user on a plane (or on a
// private-repo build) must never see an update error toast.
import { app } from "electron";
import { autoUpdater } from "electron-updater";

import type { LoadedRuntime } from "./runtime-loader";
import {
  clearPendingShellDownload,
  probeSelfUpdate,
  type SelfUpdateBlockReason,
  type SelfUpdateProbeResult,
} from "./self-update-probe";

/** First check waits for boot I/O to settle; then every 6h, matching the
 *  npm check's SUCCESS_TTL (`lib/runtime/update-check.ts`). */
const FIRST_CHECK_DELAY_MS = 15_000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Beat between "verified on disk" and the restart, so a 2s UI poll can
 *  show "Restarting Libi…" instead of the app just vanishing. */
const INSTALL_DELAY_MS = 2_500;

/**
 * Backoff for retrying a download that died mid-stream. Two retries after the
 * first attempt — three tries in all.
 *
 * Observed live during the 0.1.2 QA run: the download failed with
 * `net::ERR_NETWORK_CHANGED` after 2m13s, and the manual retry succeeded in
 * 23s. electron-updater's own `retryOnServerError` covers HTTP 5xx and EPIPE,
 * so a network change en route is not covered by it.
 *
 * Bounded on purpose. An unbounded retry against a genuinely dead connection
 * is a background process burning bandwidth on a metered link; after these,
 * the 6h re-check starts the download over on its own.
 */
const DOWNLOAD_RETRY_DELAYS_MS = [5_000, 20_000];

/**
 * Is this failure worth trying again in a minute?
 *
 * Deliberately a small allowlist rather than "retry anything that isn't a
 * 4xx". A signature check failure, a corrupt zip or a full disk fails
 * identically every time, and retrying those twice just delays the honest
 * answer by 25 seconds.
 */
export function isRetryableDownloadError(message: string): boolean {
  return /ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_IO_SUSPENDED|ERR_CONNECTION_(RESET|CLOSED|ABORTED|TIMED_OUT|REFUSED)|ERR_NAME_NOT_RESOLVED|ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENETDOWN|ENETUNREACH|EPIPE|socket hang up|network (?:error|timeout)/i.test(
    message,
  );
}

type Phase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "update-available"
  | "downloading"
  | "ready"
  | "blocked"
  | "error";

/**
 * `app.isInApplicationsFolder()`, which exists on macOS only and throws
 * elsewhere. Used to PHRASE the block message, never to decide it — see the
 * false-block argument in `self-update-probe.ts`.
 */
function isInApplicationsFolder(): boolean | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    return app.isInApplicationsFolder();
  } catch {
    return undefined;
  }
}

export function initShellUpdater(runtime: LoadedRuntime, log: (msg: string) => void): void {
  // Older runtimes predate the bridge. Additive shell-api export, so degrade
  // silently — the Settings card simply shows no shell channel.
  if (typeof runtime.api.registerShellUpdater !== "function") {
    log("shell-updater: runtime has no registerShellUpdater — skipping");
    return;
  }

  // Packaged builds read app-update.yml from Resources/. A dev tree has
  // none — allow an explicit generic-feed override for rehearsals
  // (scripts/local-registry walks the runtime flow the same way), otherwise
  // stay off outside a packaged app.
  //
  // Dev-only, https-only. This branch sets forceDevUpdateConfig, which bypasses
  // the packaged app-update.yml — combined with autoInstallOnAppQuit that would
  // turn "can set an env var for the GUI session" into persistent code execution
  // at next quit. LIBI_REGISTRY_URL next door is gated the same way.
  const feedOverride = process.env.LIBI_SHELL_UPDATE_FEED;
  const overrideAllowed =
    Boolean(feedOverride) &&
    !app.isPackaged &&
    (() => {
      try {
        return new URL(feedOverride!).protocol === "https:";
      } catch {
        return false;
      }
    })();

  if (overrideAllowed) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: "generic", url: feedOverride! });
    log(`shell-updater: feed override → ${feedOverride}`);
  } else if (!app.isPackaged) {
    log("shell-updater: not packaged and no LIBI_SHELL_UPDATE_FEED — skipping");
    return;
  }

  autoUpdater.autoDownload = true;
  // The quiet half of "restarts are explicit": a user who never clicks
  // "Restart to apply" still gets the update at their next normal quit.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m: unknown) => log(`shell-updater: ${String(m)}`),
    warn: (m: unknown) => log(`shell-updater: WARN ${String(m)}`),
    error: (m: unknown) => log(`shell-updater: ERROR ${String(m)}`),
    debug: () => {},
  };

  const status = {
    phase: "idle" as Phase,
    currentVersion: app.getVersion(),
    latestVersion: null as string | null,
    percent: null as number | null,
    error: null as string | null,
    checkedAt: null as number | null,
    // Why this install can't replace its own bundle, and the path that is the
    // evidence. Both null unless `phase === "blocked"`.
    blockedReason: null as SelfUpdateBlockReason | null,
    blockedPath: null as string | null,
    // Tells the runtime UI this shell downloads on its own and parks at
    // "ready" — old shells lack the field and keep the click-to-install UI.
    autoDownload: true as const,
  };
  // The most recent write-probe verdict. Deliberately NOT persisted anywhere:
  // the condition is environmental (the user fixes it in Finder, which the app
  // cannot observe), so every check re-probes and a fixed install clears on
  // the very next one — no cache to fight.
  let probe: SelfUpdateProbeResult = { ok: true, path: "", targetDir: "" };
  // Restart consent: set by `restart()` (the UI's "Restart to apply") or by
  // a `download()` call that arrives when the download is already ready (an
  // old runtime's "Install & restart" click). Once set, `update-downloaded`
  // — or the ready state it already reached — quits-and-installs.
  let restartRequested = false;
  /** How many download retries this version has already consumed. */
  let downloadAttempt = 0;

  autoUpdater.on("checking-for-update", () => {
    if (
      status.phase === "idle" ||
      status.phase === "up-to-date" ||
      status.phase === "blocked" ||
      status.phase === "error"
    ) {
      status.phase = "checking";
    }
  });
  autoUpdater.on("update-available", (info) => {
    // A different version is a fresh subject: its retries start over.
    if (info.version !== status.latestVersion) downloadAttempt = 0;
    status.latestVersion = info.version;
    status.error = null;
    status.checkedAt = Date.now();

    // `check()` re-probed just before this, and turned autoDownload off if the
    // bundle can't be replaced. Report that rather than an offer that would
    // download 481 MB to reach a failure.
    if (!probe.ok) {
      status.phase = "blocked";
      status.percent = null;
      status.blockedReason = probe.reason ?? "read-only-location";
      status.blockedPath = probe.path;
      log(
        `shell-updater: ${info.version} available, but this install cannot replace ` +
          `its own bundle (${status.blockedReason}) — running from ${probe.path}. Not downloading.`,
      );
      return;
    }

    // autoDownload means electron-updater starts the download right after
    // this event; "update-available" is a blink before "downloading".
    status.phase = "update-available";
    status.blockedReason = null;
    status.blockedPath = null;
    log(`shell-updater: update available ${status.currentVersion} → ${info.version} — auto-downloading`);
  });
  autoUpdater.on("update-not-available", () => {
    status.phase = "up-to-date";
    status.latestVersion = null;
    status.error = null;
    status.checkedAt = Date.now();
    // Nothing to install means nothing to be blocked from installing. Saying
    // "you can't update" to someone already current would be pure nagging.
    status.blockedReason = null;
    status.blockedPath = null;
  });
  autoUpdater.on("download-progress", (p) => {
    status.phase = "downloading";
    status.percent = Math.round(p.percent);
  });
  const quitAndInstallSoon = (): void => {
    setTimeout(() => {
      log("shell-updater: quitAndInstall");
      autoUpdater.quitAndInstall();
    }, INSTALL_DELAY_MS);
  };

  autoUpdater.on("update-downloaded", (info) => {
    status.phase = "ready";
    status.percent = 100;
    downloadAttempt = 0;
    if (restartRequested) {
      // The restart was consented while the download was still running.
      log(`shell-updater: ${info.version} downloaded — restart already requested, installing in ${INSTALL_DELAY_MS}ms`);
      quitAndInstallSoon();
    } else {
      log(`shell-updater: ${info.version} downloaded — waiting for a restart to apply`);
    }
  });
  autoUpdater.on("error", (err) => {
    // A failed auto-download is status, not a dialog: the 6h re-check (or
    // "Check again") starts it over. `error` renders as nothing, like the
    // npm check's `unknown`.
    //
    // One exception: `error` is documented as SILENT, so letting a check
    // failure overwrite a `blocked` verdict would put the user straight back
    // in the bug this all exists for — knowing nothing. Blocked outranks it.
    if (status.phase === "blocked") {
      status.error = err.message;
      status.checkedAt = Date.now();
      log(`shell-updater: error while blocked — ${err.message}`);
      return;
    }

    // A download that died mid-stream on a network hiccup deserves another
    // go: the failure says nothing about whether the file is fetchable, and
    // someone whose sessions are shorter than a 481 MB download would
    // otherwise never complete one. Only while a download was actually in
    // flight, only for network-class failures, and only twice.
    const delay = DOWNLOAD_RETRY_DELAYS_MS[downloadAttempt];
    if (
      (status.phase === "downloading" || status.phase === "update-available") &&
      isRetryableDownloadError(err.message) &&
      delay !== undefined
    ) {
      downloadAttempt += 1;
      status.error = err.message;
      status.percent = null;
      log(
        `shell-updater: download failed (${err.message}) — retry ` +
          `${downloadAttempt}/${DOWNLOAD_RETRY_DELAYS_MS.length} in ${delay}ms`,
      );
      const timer = setTimeout(() => {
        // A restart the user already consented to is NOT a reason to skip the
        // retry — the download is what that consent is waiting on.
        if (status.phase === "blocked") return;
        status.phase = "downloading";
        status.percent = 0;
        void autoUpdater.downloadUpdate().catch(() => {
          /* the error event lands back here */
        });
      }, delay);
      timer.unref?.();
      return;
    }

    status.phase = "error";
    status.percent = null;
    status.error = err.message;
    status.checkedAt = Date.now();
    restartRequested = false;
    log(`shell-updater: error — ${err.message}`);
  });

  /**
   * Re-run the write probe. Called before EVERY check — boot, the 6h timer,
   * and "Check again" — so a user who drags the app into Applications while
   * Libi is open sees the block clear without restarting.
   */
  const reprobe = (): SelfUpdateProbeResult => {
    probe = probeSelfUpdate({
      platform: process.platform,
      execPath: app.getPath("exe"),
      appImagePath: process.env.APPIMAGE ?? null,
      isInApplicationsFolder: isInApplicationsFolder(),
    });
    return probe;
  };

  const check = async (): Promise<void> => {
    // Probe first: with autoDownload on, checkForUpdates() IS the download.
    // This is the entire point of the fix — the question has to be answered
    // before the bytes move, not after.
    reprobe();
    autoUpdater.autoDownload = probe.ok;
    // Say what the probe decided, every time. Without this the blocked state
    // is invisible unless an update happens to exist — `blockedReason` is null
    // while up to date, and the cleanup below only speaks when it finds
    // something. During the v0.1.3 verification that meant A0's verdict had to
    // be inferred from a tidy-up line rather than read.
    log(
      probe.ok
        ? `shell-updater: this install can replace its own bundle (${probe.targetDir})`
        : `shell-updater: this install CANNOT replace its own bundle (${probe.reason}) — ${probe.path}`,
    );
    if (!probe.ok) {
      // A build that shipped before this check may have left a whole update
      // parked on disk that nothing will ever install. On this machine that
      // was 481 MB.
      const cleared = clearPendingShellDownload(process.resourcesPath);
      if (cleared) {
        log(`shell-updater: discarded a pending download that can never be installed — ${cleared}`);
      }
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      /* the error event above already recorded it */
    }
  };

  const restart = (): void => {
    if (status.phase === "blocked") return; // nothing was ever downloaded
    if (restartRequested) return; // already on its way down
    restartRequested = true;
    if (status.phase === "ready") quitAndInstallSoon();
    // Not ready yet: `update-downloaded` sees the flag and installs then.
  };

  runtime.api.registerShellUpdater({
    getStatus: () => ({ ...status }),
    checkNow: check,
    download: () => {
      // Back-compat path (old runtimes' "Install & restart" click). With
      // autoDownload the download is usually already running or done: ready
      // means the click's promised restart, anything in flight is a no-op,
      // and only a shell sitting idle at update-available (e.g. right after
      // an error) actually starts a download here.
      // An old runtime's UI has no idea `blocked` exists and will happily
      // send this. Re-probe rather than trusting the last verdict — the user
      // may have just fixed the location, and this click is how they'd say so.
      if (status.phase === "blocked" && !reprobe().ok) {
        log("shell-updater: refusing a download — this install cannot replace its own bundle");
        return;
      }
      if (status.phase === "ready") {
        restart();
        return;
      }
      if (status.phase === "downloading" || restartRequested) return;
      status.phase = "downloading";
      status.percent = 0;
      void autoUpdater.downloadUpdate().catch(() => {
        /* the error event above already recorded it */
      });
    },
    restart,
  });

  setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
  const timer = setInterval(() => void check(), RECHECK_INTERVAL_MS);
  timer.unref?.();
  log("shell-updater: registered");
}
