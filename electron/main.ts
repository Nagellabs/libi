// electron/main.ts
//
// KEEP THIS IMPORT FIRST. It publishes `process.env.LIBI_HOME` for a packaged
// build before any other module in this bundle is evaluated — see
// `./libi-home-bootstrap` for why that ordering matters.
import "./libi-home-bootstrap";
import { app, BrowserWindow, Notification, ipcMain, shell, dialog } from "electron";
import http from "http";
import path from "path";
import fs from "fs";
import { bootstrapPath } from "./path-bootstrap";
import { createRendererConsoleForwarder, mainSyncLog } from "./sync-log";
import { navigationDecision, windowOpenExternal } from "./nav-guard";
import { initShellUpdater } from "./shell-updater";
import {
  describeNoRuntimeFailure,
  resolveRuntime,
  MAX_SHELL_API_VERSION,
  MIN_SHELL_API_VERSION,
  type LoadedRuntime,
} from "./runtime-loader";

mainSyncLog("main.ts: module loaded");

// ── The shell↔runtime seam ────────────────────────────────────────────────
// This file used to import `../lib/server/lifecycle`,
// `../lib/server/lifecycle/adapters/electron`,
// `../lib/server/lifecycle/relaunch`, `../mcp/notify` and
// `../lib/sentry/native-crash` DIRECTLY, and boot Next from the repo layout —
// five unversioned reach-ins that compiled the runtime into the shell and made
// it impossible to release them apart.
//
// Now every one of them arrives through `runtime.api`, the single versioned
// module `lib/runtime/shell-api.ts` exports, loaded out of whichever runtime
// snapshot `resolveRuntime()` picked. `runtime` is null until the packaged
// boot resolves one — and stays null for the whole of dev, where the working
// tree is the runtime and Next runs in a separate process. Every call site
// below is written to degrade rather than assume.
let runtime: LoadedRuntime | null = null;

// Record an abnormal lifecycle / crash event durably (always, via the sync log
// that survives a hard exit) AND to Sentry (real installs only). Use
// `mainSyncLog` directly for normal/expected lines; use this for faults so the
// "window just vanished" class of bug is finally attributable.
function recordCrash(
  kind: string,
  detail: string,
  opts: {
    error?: unknown;
    level?: "fatal" | "error" | "warning";
    extra?: Record<string, unknown>;
  } = {},
): void {
  mainSyncLog(`CRASH ${kind}: ${detail}`);
  // Sentry reporting lives in the runtime (`lib/sentry/native-crash.ts`), so a
  // crash BEFORE a runtime is loaded reaches the durable sync log only. That is
  // the same trade-off `native-crash.ts` already documents for a crash before
  // the Next runtime initializes Sentry in this process — it never had a client
  // to send through at that point either.
  try {
    runtime?.api.reportNativeCrash(kind, { message: detail, ...opts });
  } catch (err) {
    mainSyncLog(`recordCrash: runtime reporter threw: ${(err as Error).message}`);
  }
}

// Main-process safety nets. An uncaught exception / unhandled rejection here
// would otherwise take the whole app down with no durable trace.
process.on("uncaughtException", (err) => {
  recordCrash(
    "uncaught_exception",
    err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    { error: err, level: "fatal" },
  );
});
process.on("unhandledRejection", (reason) => {
  recordCrash(
    "unhandled_rejection",
    reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
    { error: reason, level: "error" },
  );
});

const isDev = !app.isPackaged;
mainSyncLog(`main.ts: isDev=${isDev} __dirname=${__dirname}`);

// Opt-in escape hatch for unstable GPU environments (some headless / remote /
// virtualized dev hosts SIGTRAP the renderer on a GPU-process crash). Set
// LIBI_DISABLE_GPU=1 to force software compositing (SwiftShader). WebGL still
// works (3D overlays render in software), just slower. Must run before ready.
if (process.env.LIBI_DISABLE_GPU === "1") {
  app.disableHardwareAcceleration();
  mainSyncLog("main.ts: hardware acceleration disabled (LIBI_DISABLE_GPU=1)");
}

// Isolate the Chromium profile (userData) per worktree in dev. Unpackaged
// Electron otherwise shares ONE profile (~/Library/Application Support/Electron)
// across the canonical checkout, every worktree, and even unrelated Electron
// dev apps — so a crash in one leaves a SingletonLock that SIGTRAPs the next
// launch, and CDP/profile state cross-contaminates. LIBI_HOME is the worktree
// home in dev, giving each worktree its own profile + lock. Must run before
// the app is ready.
if (isDev && process.env.LIBI_HOME) {
  try {
    const profileDir = path.join(process.env.LIBI_HOME, "electron-profile");
    // Pre-create the dir: Chromium writes DevToolsActivePort into userData very
    // early, and if the dir is missing that write fails ("No such file or
    // directory"), leaving the CDP endpoint in a broken state.
    fs.mkdirSync(profileDir, { recursive: true });
    app.setPath("userData", profileDir);
    mainSyncLog(`main.ts: dev userData → ${profileDir}`);
  } catch (err) {
    mainSyncLog(`main.ts: setPath(userData) failed: ${(err as Error).message}`);
  }
}

if (!isDev) {
  // Already published by `./libi-home-bootstrap` (imported first, above) so it
  // is in place before any module-scope consumer reads it. Re-asserted here
  // only so the value is impossible to miss when reading this file, and logged
  // as the boot breadcrumb it has always been.
  process.env.LIBI_HOME ??= app.getPath("userData");
  mainSyncLog(`main.ts: LIBI_HOME set to ${process.env.LIBI_HOME}`);
  // launchd-launched .apps have a minimal PATH (no Homebrew, no proto,
  // no nvm). Without this, subprocess spawns for npm/uv/ffmpeg fail
  // with ENOENT and Category A hangs on its first install step.
  mainSyncLog("main.ts: calling bootstrapPath()");
  bootstrapPath();
  mainSyncLog("main.ts: bootstrapPath() done");
  // NB: the cwd move happens LATER, in the ready handler, once the runtime has
  // been resolved — see `chdirToRuntime()`. It used to be
  // `chdir(<app>/dist-electron/../..)` here, back when the app directory WAS
  // the libi tree. It no longer is: the tree lives in the runtime snapshot, and
  // its location isn't known until `resolveRuntime()` has run. Nothing between
  // this point and there reads `process.cwd()` (the splash is loaded by
  // absolute path; `bootstrapPath` and `libi-home-bootstrap` are cwd-free).
}

// In dev mode, expose the Chrome DevTools Protocol so an agent (via
// `@playwright/mcp --cdp-endpoint=…`) or a Playwright test can attach
// to the running Electron app. This is the standard mechanism — Discord,
// Slack, VS Code, Cursor etc. all rely on the same flag. Gated to dev
// only: enabling CDP in a packaged production app would let anyone with
// local network access drive the renderer.
//
// The port is configurable via LIBI_CDP_PORT (default 9222). Set
// LIBI_CDP=0 to opt out (e.g. for a headless test run that owns its
// own Playwright `_electron.launch()`).
if (isDev && process.env.LIBI_CDP !== "0") {
  const cdpPort = process.env.LIBI_CDP_PORT ?? "9222";
  app.commandLine.appendSwitch("remote-debugging-port", cdpPort);
  // Narrowed to the loopback CDP origin itself. Playwright's CDP client sends
  // no Origin header, so this buys real restriction without breaking the
  // documented remote-driving workflow — a wildcard here would let any page
  // the renderer navigates to (or any other local process) attach and drive it.
  app.commandLine.appendSwitch("remote-allow-origins", `http://127.0.0.1:${cdpPort}`);
  console.log(
    `[electron] CDP enabled — chrome://inspect or playwright-mcp --cdp-endpoint=http://localhost:${cdpPort}`,
  );
}

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let serverPort: number | null = null;

function createSplash(): BrowserWindow {
  splashWindow = new BrowserWindow({
    width: 560,
    height: 640,
    resizable: false,
    frame: false,
    transparent: false,
    backgroundColor: "#09090b",
    // Splash should look like it belongs to the app, not a debug window.
    // Hide the dock icon's "loading" dot on macOS by giving the window
    // a clean shadow + center it on the active display.
    center: true,
    titleBarStyle: "hidden",
    // RC-G: isolate the splash renderer like the main window. It receives
    // lifecycle progress + can quit via the `splash-preload.js` contextBridge,
    // NOT via `require("electron")` / raw node integration.
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "splash-preload.js"),
    },
  });
  splashWindow.loadFile(path.join(__dirname, "splash.html"));
  return splashWindow;
}

function createMainWindow(port: number) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // macOS traffic-light buttons are ~12 px in diameter. For visual
    // vertical centering inside the 36 px <TopBar />, the top of the
    // button group sits at (36 - 12) / 2 = 12. (Electron's `y` is the
    // distance from the top of the window to the TOP of the buttons.)
    trafficLightPosition: { x: 16, y: 12 },
    backgroundColor: "#09090b",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // Explicit rather than inherited. These are the current Electron defaults,
      // but they have shifted across majors, and this is the first thing an
      // Electron reviewer greps for.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const appOrigin = `http://127.0.0.1:${port}`;
  mainSyncLog(`createMainWindow: loadURL ${appOrigin}`);
  mainWindow.loadURL(appOrigin);

  // RC-G: lock the renderer to its own loopback origin. A compiled-JS
  // `window.location = "https://evil"` (RC-C residual) would otherwise carry the
  // preload bridge + same-origin cookies to an attacker origin. Block any
  // in-window navigation off `appOrigin`; legitimate external http(s) links are
  // handed to the OS browser instead of navigating the app away.
  mainWindow.webContents.on("will-navigate", (e, url) => {
    const decision = navigationDecision(url, appOrigin);
    if (decision.allow) return;
    e.preventDefault();
    mainSyncLog(`will-navigate blocked (off-origin): ${url}`);
    if (decision.openExternal) void shell.openExternal(decision.openExternal);
  });

  // RC-G: window.open / target="_blank" must never spawn an Electron window
  // (which would inherit the preload). External http(s) links open in the user's
  // real browser; everything else is denied outright.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const external = windowOpenExternal(url);
    if (external) void shell.openExternal(external);
    return { action: "deny" };
  });

  mainWindow.webContents.on("did-finish-load", () => {
    mainSyncLog("createMainWindow: did-finish-load");
  });
  // Renderer console.error → electron-main-sync.log. In production nothing
  // else puts client-side errors on disk: Next's `[browser]` relay into
  // server.log is dev-only, and the packaged app has no DevTools for the user
  // to read. Errors-only, truncated, capped — see sync-log.ts.
  const forwardRendererConsole = createRendererConsoleForwarder();
  mainWindow.webContents.on("console-message", (details) => {
    forwardRendererConsole({
      level: details.level,
      message: details.message,
      sourceId: details.sourceId,
      lineNumber: details.lineNumber,
    });
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    mainSyncLog(`createMainWindow: did-fail-load ${code} ${desc} url=${url}`);
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    const line = `reason=${details.reason} exitCode=${details.exitCode}`;
    // `clean-exit` is normal teardown; everything else (crashed / killed / oom /
    // launch-failed / integrity-failure) is the renderer dying under us.
    if (details.reason === "clean-exit") {
      mainSyncLog(`render-process-gone (clean): ${line}`);
    } else {
      recordCrash("render_process_gone", line, {
        level:
          details.reason === "oom" || details.reason === "crashed"
            ? "fatal"
            : "error",
        extra: { ...details },
      });
    }
  });
  mainWindow.webContents.on("unresponsive", () => {
    recordCrash("renderer_unresponsive", "renderer stopped responding (hang)", {
      level: "warning",
    });
  });
  mainWindow.webContents.on("responsive", () => {
    mainSyncLog("renderer responsive again");
  });
  mainWindow.once("ready-to-show", () => {
    mainSyncLog("createMainWindow: ready-to-show → show()");
    mainWindow?.show();
  });
  // Belt and braces: if ready-to-show doesn't fire within 3s (e.g. the
  // initial fetch fails), show the window anyway so the user isn't
  // staring at nothing.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      mainSyncLog("createMainWindow: 3s fallback → show() (ready-to-show never fired)");
      mainWindow.show();
    }
  }, 3000);
  // Auto-open DevTools in dev — but NOT when an external CDP client (Playwright /
  // an agent MCP) will drive this app. Two DevTools front-ends attached to the
  // same page target make Chromium's browser-main thread CHECK-fail (SIGTRAP).
  // Set LIBI_NO_DEVTOOLS=1 when remote-driving via --remote-debugging-port.
  if (isDev && process.env.LIBI_NO_DEVTOOLS !== "1")
    mainWindow.webContents.openDevTools({ mode: "detach" });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function startNextServer(): Promise<number> {
  if (isDev) {
    // In dev mode the Next.js server is launched separately (see
    // `npm run dev:electron`). Read the port from the env (set by the
    // dev script) or fall back to the default.
    const envPort = process.env.LIBI_PORT ? Number(process.env.LIBI_PORT) : NaN;
    return Number.isFinite(envPort) ? envPort : 3456;
  }
  // The production server now belongs to the RUNTIME, not the shell: `next`
  // and `.next` both live inside the resolved runtime snapshot, so the shell
  // has neither to boot from. `startNextServer` (lib/server/next-server.ts)
  // carries the bind-then-prepare ordering verbatim; read its header for why
  // that ordering is load-bearing.
  if (!runtime) {
    throw new Error("startNextServer: no runtime loaded");
  }
  const started = await runtime.api.startNextServer({
    dir: runtime.root,
    log: mainSyncLog,
  });
  return started.port;
}

/** Poll an HTTP server until it responds OR `timeoutMs` elapses. Returns
 *  true on success, false on timeout. Used in dev mode where the Next.js
 *  server may still be compiling when Electron starts. */
async function waitForServer(port: number, timeoutMs = 60_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/", timeout: 1000 },
        (res) => {
          res.resume();
          resolve((res.statusCode ?? 0) > 0);
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

ipcMain.on("splash-quit", () => app.quit());

ipcMain.handle("libi:reveal-file", (_e, absPath: string) => {
  if (typeof absPath === "string" && absPath.length > 0) {
    shell.showItemInFolder(absPath);
  }
});

ipcMain.handle("libi:pick-directory", async (_e, initialPath: string | null) => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    defaultPath: initialPath ?? undefined,
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

/** Window controls used by the in-app TopBar. */
ipcMain.handle("libi:window-minimize", () => mainWindow?.minimize());
ipcMain.handle("libi:window-maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle("libi:window-close", () => mainWindow?.close());
ipcMain.handle("libi:window-is-maximized", () =>
  mainWindow?.isMaximized() ?? false,
);

app.on("ready", async () => {
  mainSyncLog("app.on ready: handler entered");
  // Dev runs the bare Electron binary, whose dock icon is the stock Electron
  // atom — packaged builds get build/icon.icns from electron-builder instead.
  // __dirname is dist-electron/electron/, so the repo's build/ is two up.
  if (!app.isPackaged && process.platform === "darwin") {
    const devIcon = path.join(__dirname, "..", "..", "build", "icon.png");
    if (fs.existsSync(devIcon)) app.dock?.setIcon(devIcon);
  }
  // Dev mode: skip the splash + Category A. The CLI parent
  // (`node bin/libi.js`) already ran Category A before launching Next,
  // so re-running it here would be wasteful and noisy. Just wait for
  // the Next dev server to come up and open the main window.
  if (isDev) {
    serverPort = await startNextServer();
    const ok = await waitForServer(serverPort);
    if (!ok) {
      dialog.showErrorBox(
        "libi dev",
        `Next.js dev server on http://127.0.0.1:${serverPort} did not respond within 60s.\n\nMake sure \`npm run dev\` is running in another terminal, or use \`npm run dev:electron\` to start both together.`,
      );
      app.quit();
      return;
    }
    createMainWindow(serverPort);
    // Dev has no loaded runtime, so there is no `bindNotifier` to call. That
    // costs nothing: in dev the Next server is a SEPARATE process with its own
    // copy of `mcp/notify`, so binding a notifier here never reached the code
    // that raises them anyway.
    return;
  }

  mainSyncLog("about to createSplash");
  const splash = createSplash();
  mainSyncLog("createSplash returned, waiting did-finish-load");
  await new Promise<void>((r) =>
    splash.webContents.once("did-finish-load", () => r()),
  );
  mainSyncLog("splash did-finish-load");

  // ── Resolve the runtime BEFORE anything else needs it ────────────────────
  // Everything from here down (Category A, the Next server, the notifier) is
  // runtime code. `resolveRuntime` prefers a fetched `<LIBI_HOME>/runtime/<v>/`
  // and falls back to the snapshot bundled in the .app, so this step is offline-
  // safe by construction — it reads the disk and never the network.
  const resolved = resolveRuntime({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    libiHome: process.env.LIBI_HOME ?? app.getPath("userData"),
    log: mainSyncLog,
  });
  if (!resolved.runtime) {
    // The genuinely fatal case: not even the bundled snapshot is usable, so the
    // app cannot run at all. Deliberately NOT phrased as a network failure —
    // see `describeNoRuntimeFailure`.
    const { error, hint } = describeNoRuntimeFailure(resolved.rejections);
    mainSyncLog(`runtime-loader: FATAL — ${error}`);
    splash.webContents.send("lifecycle", {
      kind: "fatal",
      phase: "category-a",
      step: null,
      error,
      hint,
    });
    return;
  }
  runtime = resolved.runtime;
  // ── Publish the shell↔runtime facts the RUNTIME cannot derive ────────────
  // The update check (`lib/runtime/update-check.ts`) has to answer "can THIS
  // desktop app run the version npm is advertising?", and the answer is this
  // shell's supported `shellApiVersion` RANGE — a constant compiled into this
  // bundle, invisible from inside the runtime. The other two just save the
  // runtime from re-deriving what was already resolved here.
  //
  // Safe because the packaged Next server runs IN this process (see
  // `startNextServer` below), so these assignments are simply visible to it.
  // Every one has a fallback in `lib/runtime/current-runtime.ts`, so an older
  // shell driving a newer runtime degrades rather than breaks.
  process.env.LIBI_RUNTIME_VERSION = runtime.version;
  process.env.LIBI_RUNTIME_SOURCE = runtime.source;
  // What this .app ships, whether or not it won the selection. The runtime
  // knows what it IS, not what it was chosen over — and it needs the latter to
  // prune staged runtimes that can never be selected again (~1.3 GB each), and
  // to say which runtime is actually live when a staged one was superseded.
  if (resolved.bundledVersion) {
    process.env.LIBI_BUNDLED_VERSION = resolved.bundledVersion;
  }
  process.env.LIBI_SHELL_API_MIN = String(MIN_SHELL_API_VERSION);
  process.env.LIBI_SHELL_API_MAX = String(MAX_SHELL_API_VERSION);
  // A rejected candidate with a working fallback is NOT a user-facing error —
  // the app works. It is logged and nothing else.
  for (const r of resolved.rejections) {
    mainSyncLog(`runtime-loader: (non-fatal) skipped ${r.prefix}: ${r.reason}`);
  }

  // Move cwd into the runtime tree. Several libi modules resolve paths via
  // `process.cwd()` — drizzle's migrations folder, the tracking sidecar's
  // project dir, the tsx alias search — and when the app is launched from
  // Finder/launchd cwd is `/`, so those lookups silently fail. This used to
  // happen at module load against the app directory; the libi tree now lives
  // in the runtime snapshot, so it has to happen here.
  try {
    process.chdir(runtime.root);
    mainSyncLog(`main.ts: chdir to runtime root, cwd=${process.cwd()}`);
  } catch (err) {
    mainSyncLog(`main.ts: chdir(${runtime.root}) failed: ${(err as Error).message}`);
  }

  runtime.api.setRelaunchHandler(() => {
    app.relaunch();
    app.exit(0);
  });

  const result = await runtime.api.runInstallPhase({
    adapter: runtime.api.electronAdapter(splash),
  });
  mainSyncLog(`runInstallPhase returned: ok=${result.ok}`);
  if (!result.ok) {
    // Splash already received the fatal event; user clicks Quit there.
    return;
  }

  try {
    mainSyncLog("about to startNextServer");
    serverPort = await startNextServer();
    mainSyncLog(`startNextServer done, port=${serverPort}`);
  } catch (err) {
    splash.webContents.send("lifecycle", {
      kind: "fatal",
      phase: "category-a",
      step: null,
      error: err instanceof Error ? err.message : String(err),
      hint: "Failed to start the in-process Next.js server.",
    });
    return;
  }

  mainSyncLog("about to createMainWindow");
  createMainWindow(serverPort);
  mainSyncLog("createMainWindow done");
  runtime.api.bindNotifier({
    isFocused: () => mainWindow?.isFocused() === true,
    notify: (p) => {
      const n = new Notification({ title: p.title, body: p.body });
      n.on("click", () => {
        mainWindow?.show();
        mainWindow?.focus();
        if (p.pieceId) {
          mainWindow?.webContents.send("libi:open-piece", p.pieceId);
        }
      });
      n.show();
    },
  });
  splash.close();
  splashWindow = null;
  mainSyncLog("splash closed; main window should be visible");
  // After the window is up so the first feed check never competes with boot
  // I/O. Registers the ShellUpdater bridge the update route reads — the
  // shell's OWN update channel (GitHub Releases), distinct from the npm
  // runtime updates the route also reports.
  initShellUpdater(runtime, mainSyncLog);
});

app.on("window-all-closed", () => {
  // Normal on macOS when the user closes the window — but our handler quits the
  // WHOLE stack (and in dev, dev-electron then tears down Next), so the app
  // "vanishes". Logging it makes a window-close distinguishable from a crash.
  // Not a fault → durable log only, no Sentry.
  mainSyncLog("window-all-closed → app.quit()");
  app.quit();
});
app.on("activate", () => {
  if (!mainWindow && serverPort) createMainWindow(serverPort);
});

// ── Crash / abnormal-exit instrumentation ──────────────────────────────────
// A GPU / utility / network subprocess dying is the usual silent killer of the
// window and the one case macOS writes NO `.ips` for. `reason: "clean-exit"` is
// normal teardown; anything else is a real fault worth a Sentry event.
app.on("child-process-gone", (_e, details) => {
  const line =
    `type=${details.type} reason=${details.reason} exitCode=${details.exitCode}` +
    (details.name ? ` name=${details.name}` : "") +
    (details.serviceName ? ` service=${details.serviceName}` : "");
  if (details.reason === "clean-exit") {
    mainSyncLog(`child-process-gone (clean): ${line}`);
  } else {
    recordCrash("child_process_gone", line, {
      level: details.reason === "oom" ? "fatal" : "error",
      extra: { ...details },
    });
  }
});

// Final exit breadcrumbs — captures the actual exit code no matter which path
// (window close, crash handler, relaunch, parent signal) led here.
app.on("before-quit", () => mainSyncLog("app before-quit"));
app.on("will-quit", () => mainSyncLog("app will-quit"));
app.on("quit", (_e, exitCode) => mainSyncLog(`app quit: exitCode=${exitCode}`));
