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
// route can poll. Two behavioural rules, both mirroring the runtime-update
// flow the user already knows:
//
//  * **No download without a click.** `autoDownload` is off; `download()` is
//    only ever called by the route handling the user's "Install & restart".
//  * **That click is the consent for the restart.** Once the download is
//    verified on disk we quit-and-install after a short beat (long enough
//    for the UI's next poll to render "Restarting Libi…"). There is no
//    lingering "downloaded, restart later" state to strand.
//
// Failures are status, not dialogs: `phase: "error"` renders as nothing,
// exactly like the npm check's `unknown` — a user on a plane (or on a
// private-repo build) must never see an update error toast.
import { app } from "electron";
import { autoUpdater } from "electron-updater";

import type { LoadedRuntime } from "./runtime-loader";

/** First check waits for boot I/O to settle; then every 6h, matching the
 *  npm check's SUCCESS_TTL (`lib/runtime/update-check.ts`). */
const FIRST_CHECK_DELAY_MS = 15_000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Beat between "verified on disk" and the restart, so a 2s UI poll can
 *  show "Restarting Libi…" instead of the app just vanishing. */
const INSTALL_DELAY_MS = 2_500;

type Phase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "update-available"
  | "downloading"
  | "ready"
  | "error";

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

  autoUpdater.autoDownload = false;
  // Belt-and-braces: if the user quits between "ready" and our own
  // quitAndInstall beat, the update still applies on the way out.
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
  };
  // The user's Install click, remembered so `update-downloaded` knows the
  // restart is consented. autoDownload is off, so this is the only way a
  // download starts — the flag is documentation as much as a guard.
  let installRequested = false;

  autoUpdater.on("checking-for-update", () => {
    if (status.phase === "idle" || status.phase === "up-to-date" || status.phase === "error") {
      status.phase = "checking";
    }
  });
  autoUpdater.on("update-available", (info) => {
    status.phase = installRequested ? status.phase : "update-available";
    status.latestVersion = info.version;
    status.error = null;
    status.checkedAt = Date.now();
    log(`shell-updater: update available ${status.currentVersion} → ${info.version}`);
  });
  autoUpdater.on("update-not-available", () => {
    status.phase = "up-to-date";
    status.latestVersion = null;
    status.error = null;
    status.checkedAt = Date.now();
  });
  autoUpdater.on("download-progress", (p) => {
    status.phase = "downloading";
    status.percent = Math.round(p.percent);
  });
  autoUpdater.on("update-downloaded", (info) => {
    status.phase = "ready";
    status.percent = 100;
    log(`shell-updater: ${info.version} downloaded — restarting to install in ${INSTALL_DELAY_MS}ms`);
    if (installRequested) {
      setTimeout(() => {
        log("shell-updater: quitAndInstall");
        autoUpdater.quitAndInstall();
      }, INSTALL_DELAY_MS);
    }
  });
  autoUpdater.on("error", (err) => {
    // Mid-download failure returns to the OFFER, not to silence — the user
    // already clicked Install, and "the button is back" beats "it vanished".
    status.phase = installRequested && status.latestVersion ? "update-available" : "error";
    status.percent = null;
    status.error = err.message;
    status.checkedAt = Date.now();
    installRequested = false;
    log(`shell-updater: error — ${err.message}`);
  });

  const check = async (): Promise<void> => {
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      /* the error event above already recorded it */
    }
  };

  runtime.api.registerShellUpdater({
    getStatus: () => ({ ...status }),
    checkNow: check,
    download: () => {
      if (installRequested) return; // already in flight
      installRequested = true;
      status.phase = "downloading";
      status.percent = 0;
      void autoUpdater.downloadUpdate().catch(() => {
        /* the error event above already recorded it */
      });
    },
  });

  setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
  const timer = setInterval(() => void check(), RECHECK_INTERVAL_MS);
  timer.unref?.();
  log("shell-updater: registered");
}
