import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One desktop app per data folder.
 *
 * A second Libi.exe launch on a fresh Windows install ran the whole boot
 * against the same home as the window already open: its own server, its own
 * aggregator, a rewritten `<LIBI_HOME>/port`. Then it went away, and the first
 * window's libi tools followed the port file to a server that no longer
 * existed. The packaged shell now holds Electron's single-instance lock, so a
 * second launch hands focus to the running app and quits before doing anything.
 *
 * `electron/main.ts` is imported with `electron` and its sibling shell modules
 * mocked, the same way `main-does-not-await-shell-env.test.ts` does it.
 */
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  isPackaged: true,
  lock: true,
  requestSingleInstanceLock: vi.fn(),
  quit: vi.fn(),
  bootstrapPath: vi.fn(),
  mainSyncLog: vi.fn(),
  createSplash: vi.fn(),
  resolveRuntime: vi.fn(),
  runInstallPhase: vi.fn(),
  windows: [] as Array<Record<string, ReturnType<typeof vi.fn>> & { minimized: boolean }>,
}));

function fakeWindow() {
  const w = {
    minimized: false,
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => w.minimized),
    isVisible: vi.fn(() => true),
    restore: vi.fn(() => {
      w.minimized = false;
    }),
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
    loadURL: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
    webContents: {
      on: vi.fn(),
      once: vi.fn((_event: string, cb: () => void) => cb()),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      openDevTools: vi.fn(),
    },
  };
  return w;
}

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return h.isPackaged;
    },
    requestSingleInstanceLock: h.requestSingleInstanceLock,
    on: (event: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(event, fn);
    },
    getPath: () => "/tmp/libi-main-single-instance-userdata",
    quit: h.quit,
    relaunch: vi.fn(),
    exit: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    disableHardwareAcceleration: vi.fn(),
    setPath: vi.fn(),
    dock: { setIcon: vi.fn() },
  },
  BrowserWindow: vi.fn(function FakeBrowserWindow() {
    const w = fakeWindow();
    h.windows.push(w as never);
    return w;
  }),
  Notification: vi.fn(),
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
  dialog: { showErrorBox: vi.fn(), showOpenDialog: vi.fn() },
}));
vi.mock("../../../electron/libi-home-bootstrap", () => ({}));
vi.mock("../../../electron/path-bootstrap", () => ({ bootstrapPath: h.bootstrapPath }));
vi.mock("../../../electron/sync-log", () => ({
  mainSyncLog: h.mainSyncLog,
  createRendererConsoleForwarder: () => vi.fn(),
}));
vi.mock("../../../electron/nav-guard", () => ({ navigationDecision: vi.fn(), windowOpenExternal: vi.fn() }));
vi.mock("../../../electron/shell-updater", () => ({ initShellUpdater: vi.fn() }));
vi.mock("../../../electron/splash-window", () => ({ createSplash: h.createSplash }));
vi.mock("../../../electron/runtime-loader", () => ({
  MIN_SHELL_API_VERSION: 1,
  MAX_SHELL_API_VERSION: 1,
  describeNoRuntimeFailure: vi.fn(),
  resolveRuntime: h.resolveRuntime,
}));

let envSnapshot: NodeJS.ProcessEnv;
let libiHome: string;

beforeEach(() => {
  envSnapshot = { ...process.env };
  libiHome = mkdtempSync(path.join(os.tmpdir(), "libi-main-single-instance-"));
  process.env.LIBI_HOME = libiHome;
  process.env.LIBI_CDP = "0";
  h.handlers.clear();
  h.windows.length = 0;
  h.isPackaged = true;
  h.lock = true;
  for (const fn of [h.requestSingleInstanceLock, h.quit, h.bootstrapPath, h.mainSyncLog, h.createSplash, h.resolveRuntime, h.runInstallPhase]) {
    fn.mockReset();
  }
  h.requestSingleInstanceLock.mockImplementation(() => h.lock);
  h.bootstrapPath.mockImplementation(() => ({ probeSettled: Promise.resolve() }));
  h.createSplash.mockImplementation(() => fakeWindow());
  h.resolveRuntime.mockImplementation(() => ({
    runtime: {
      version: "0.0.0-test",
      source: "bundled",
      root: "/nonexistent-runtime-root",
      api: {
        setRelaunchHandler: vi.fn(),
        electronAdapter: vi.fn(),
        runInstallPhase: h.runInstallPhase,
        startNextServer: vi.fn(async () => ({ port: 55268 })),
        bindNotifier: vi.fn(),
        reportNativeCrash: vi.fn(),
      },
    },
    rejections: [],
    bundledVersion: "0.0.0-test",
  }));
  // main.ts moves cwd into the runtime and installs process-wide crash handlers;
  // neither may touch the vitest worker.
  vi.spyOn(process, "chdir").mockImplementation(() => {});
  const realOn = process.on.bind(process);
  vi.spyOn(process, "on").mockImplementation(((event: string, fn: (...args: unknown[]) => void) =>
    event === "uncaughtException" || event === "unhandledRejection" ? process : realOn(event, fn)) as unknown as typeof process.on);
});

afterEach(() => {
  process.env = envSnapshot;
  rmSync(libiHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function importMain() {
  // A fresh import every time: module-scope work is exactly what is under test.
  vi.resetModules();
  await import("../../../electron/main");
}

describe("electron/main.ts: one running app per data folder", () => {
  it("a second packaged launch quits before any boot work: no shell-environment probe, and its ready handler builds no splash, runtime or server", async () => {
    h.lock = false;
    await importMain();

    expect(h.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(h.bootstrapPath).not.toHaveBeenCalled();
    expect(h.mainSyncLog).toHaveBeenCalledWith(expect.stringMatching(/already running/));

    // Electron may still deliver `ready` to a process that called quit() first.
    const ready = h.handlers.get("ready");
    if (ready) await ready();
    expect(h.createSplash).not.toHaveBeenCalled();
    expect(h.resolveRuntime).not.toHaveBeenCalled();
    expect(h.runInstallPhase).not.toHaveBeenCalled();
    expect(h.windows).toHaveLength(0);
  });

  it("takes the lock before the shell-environment probe starts", async () => {
    await importMain();
    expect(h.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(h.bootstrapPath).toHaveBeenCalledTimes(1);
    expect(h.requestSingleInstanceLock.mock.invocationCallOrder[0]).toBeLessThan(
      h.bootstrapPath.mock.invocationCallOrder[0],
    );
    expect(h.quit).not.toHaveBeenCalled();
  });

  it("the running app answers a second launch by focusing the splash while it boots, then the main window once it is up, restoring it when minimized", async () => {
    let finishInstall!: (r: { ok: boolean }) => void;
    h.runInstallPhase.mockImplementation(() => new Promise((r) => (finishInstall = r)));
    await importMain();
    const secondInstance = h.handlers.get("second-instance");
    expect(secondInstance).toBeTypeOf("function");

    const booting = h.handlers.get("ready")!() as Promise<void>;
    await vi.waitFor(() => expect(h.runInstallPhase).toHaveBeenCalled());
    const splash = h.createSplash.mock.results[0].value as ReturnType<typeof fakeWindow>;

    secondInstance!({}, [], "");
    expect(splash.show).toHaveBeenCalled();
    expect(splash.focus).toHaveBeenCalledTimes(1);

    finishInstall({ ok: true });
    await booting;
    expect(splash.close).toHaveBeenCalled();
    expect(h.windows).toHaveLength(1);
    const main = h.windows[0];
    main.minimized = true;

    secondInstance!({}, [], "");
    expect(main.restore).toHaveBeenCalledTimes(1);
    expect(main.show).toHaveBeenCalled();
    expect(main.focus).toHaveBeenCalledTimes(1);
    // The closed splash is not what a second launch brings forward any more.
    expect(splash.focus).toHaveBeenCalledTimes(1);
  });

  it("the main window it opens gets the right-click menu Electron doesn't draw by itself", async () => {
    h.runInstallPhase.mockImplementation(async () => ({ ok: true }));
    await importMain();
    await (h.handlers.get("ready")!() as Promise<void>);
    expect(h.windows).toHaveLength(1);
    const main = h.windows[0] as unknown as { webContents: { on: ReturnType<typeof vi.fn> } };
    expect(main.webContents.on).toHaveBeenCalledWith("context-menu", expect.any(Function));
  });

  it("dev launches never take the lock, so the Electron e2e harness can run beside a dev shell on the same LIBI_HOME", async () => {
    h.isPackaged = false;
    await importMain();
    expect(h.requestSingleInstanceLock).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
    expect(h.handlers.has("second-instance")).toBe(false);
  });
});
