import { createRequire } from "node:module";

import type { RenderDriver } from "./types";
import { getRenderJobTokenByJobId, rejectRenderJob } from "@/lib/export/render-jobs";
import { waitForRenderJobSettlement } from "./settle-wait";
import { exportLogger } from "@/lib/logger";

// The hidden BrowserWindow outlives the registry entry by a small grace, and is
// torn down promptly once the entry settles. The driver waits for a window
// close/crash OR for the registry entry to settle (resolve on success, reject on
// stall/cap) — then holds the window open for a short grace so any in-flight
// postback/logging completes. This replaces the old fixed hard cap that lingered
// a full extra minute after a timeout.
const GRACE_MS = 5_000;

type ElectronMain = typeof import("electron");

function loadElectron(): ElectronMain {
  // MUST be a runtime `createRequire`, never `import("electron")`.
  //
  // `electron` is deliberately NOT in `serverExternalPackages` (see the long
  // note in next.config.ts — adding it breaks electron-builder's packaging
  // step outright). A statically visible `import("electron")` is therefore not
  // a filesystem lookup after bundling: Turbopack BUNDLES the npm `electron`
  // package's stub `index.js` into the server chunk. That stub only reads
  // `path.txt` to find a downloaded binary, which a packaged app has no reason
  // to contain, so it throws:
  //
  //   Electron failed to install correctly, please delete node_modules/electron
  //   and try installing again
  //
  // Measured on the packaged app, 2026-08-02: chromium-render export failed
  // 100% of the time with exactly that message, and the emitted chunk
  // (`.next/server/chunks/node_modules_electron_index_*.js`) is the inlined
  // stub. The advice in the message is also nonsense for an end user holding a
  // signed .app — there is no node_modules/electron to reinstall.
  //
  // This is the same bundler trap `resolveVendoredNpmCli` documents in
  // lib/install/npm-root.ts. `createRequire` produces a REAL Node require the
  // bundler cannot see through; inside an Electron main process Node resolves
  // `electron` to the BUILT-IN module (registered ahead of any node_modules
  // lookup), which is the API we actually want.
  //
  // Only reached when `pickDriver()` already confirmed `process.versions
  // .electron`, so the builtin is guaranteed to be present.
  const requireFn = createRequire(__filename);
  return requireFn("electron") as ElectronMain;
}

export const electronDriver: RenderDriver = {
  name: "electron",
  async runJob({ jobId, port }) {
    const entry = getRenderJobTokenByJobId(jobId);
    if (!entry) throw new Error(`No registry entry for job ${jobId}`);

    const { BrowserWindow } = loadElectron();
    const win = new BrowserWindow({
      show: false,
      width: 1920,
      height: 1080,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    const url = `http://127.0.0.1:${port}/render?jobId=${encodeURIComponent(jobId)}&token=${encodeURIComponent(entry.token)}`;

    exportLogger.info({ event: "electron_window_open", jobId }, "export.electron_window_open");
    let graceTimer: NodeJS.Timeout | undefined;
    // If window close/crash wins the race, the finally runs while the settlement
    // promise is still pending; when it later resolves it must NOT arm a stray
    // grace timer after teardown. `raceDone` guards that ordering.
    let raceDone = false;
    try {
      await win.loadURL(url);
      // Keep the window alive while the render page runs and POSTs its result.
      // The caller (ChromiumRenderBackend) awaits the registry promise, so we just need
      // to not destroy the window prematurely. Wait for a crash/close event OR for the
      // registry entry to settle, then hold a short grace before teardown.
      await Promise.race([
        new Promise<void>((resolve) => {
          // "render-process-gone" is a renderer death that will never POST a
          // result back. Reject the registry entry immediately so `handle.done`
          // fails now instead of hanging until the stall watchdog / absolute cap
          // fires. rejectRenderJob is idempotent on already-settled entries, so a
          // crash after a successful settlement is a safe no-op. "closed" is the
          // normal success teardown.
          win.webContents.on("render-process-gone", () => {
            rejectRenderJob(jobId, entry.token, "render page crashed");
            resolve();
          });
          win.on("closed", () => resolve());
        }),
        waitForRenderJobSettlement(jobId).then(
          () => new Promise<void>((resolve) => {
            if (raceDone) { resolve(); return; }
            graceTimer = setTimeout(resolve, GRACE_MS);
          }),
        ),
      ]);
    } finally {
      raceDone = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (!win.isDestroyed()) win.destroy();
      exportLogger.info({ event: "electron_window_close", jobId }, "export.electron_window_close");
    }
  },
  async shutdown() {
    // Nothing to clean up — windows are per-job.
  },
};
