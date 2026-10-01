import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * EL-2, wired into electron/main.ts: the packaged boot tells a runtime that has
 * the hook that the shell owns SIGINT/SIGTERM BEFORE the server starts (Category
 * B reads the claim when it installs its listeners), and `before-quit` holds the
 * quit to run the runtime's shutdown. An older runtime is never claimed and
 * never held. The harness is main-single-instance.test.ts's: `electron` and the
 * sibling shell modules mocked, main.ts imported fresh.
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
  userData: "/tmp/libi-main-single-instance-userdata",
  lockedOn: [] as string[],
  windows: [] as Array<Record<string, ReturnType<typeof vi.fn>> & { minimized: boolean }>,
  claimQuitSignals: vi.fn(),
  shutdownForQuit: vi.fn(),
  startNextServer: vi.fn(),
  withQuitHook: true,
  registerSecretCipher: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
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
    getPath: (k: string) => (k === "appData" ? "/tmp/libi-main-single-instance-appdata" : h.userData),
    setName: vi.fn(),
    quit: h.quit,
    relaunch: vi.fn(),
    exit: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    disableHardwareAcceleration: vi.fn(),
    setPath: (k: string, v: string) => {
      if (k === "userData") h.userData = v;
    },
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
  safeStorage: h.safeStorage,
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
  h.userData = "/tmp/libi-main-single-instance-userdata";
  h.lockedOn.length = 0;
  h.withQuitHook = true;
  for (const fn of [h.requestSingleInstanceLock, h.quit, h.bootstrapPath, h.mainSyncLog, h.createSplash, h.resolveRuntime, h.runInstallPhase, h.claimQuitSignals, h.shutdownForQuit, h.startNextServer, h.registerSecretCipher, h.safeStorage.isEncryptionAvailable, h.safeStorage.encryptString, h.safeStorage.decryptString]) {
    fn.mockReset();
  }
  // Record the userData the lock was keyed on at the moment it was requested.
  h.requestSingleInstanceLock.mockImplementation(() => {
    h.lockedOn.push(h.userData);
    return h.lock;
  });
  h.bootstrapPath.mockImplementation(() => ({ probeSettled: Promise.resolve() }));
  h.createSplash.mockImplementation(() => fakeWindow());
  h.startNextServer.mockImplementation(async () => ({ port: 55268 }));
  h.shutdownForQuit.mockImplementation(async () => true);
  h.runInstallPhase.mockImplementation(async () => ({ ok: true }));
  h.resolveRuntime.mockImplementation(() => ({
    runtime: {
      version: "0.0.0-test",
      source: "bundled",
      root: "/nonexistent-runtime-root",
      api: {
        setRelaunchHandler: vi.fn(),
        electronAdapter: vi.fn(),
        runInstallPhase: h.runInstallPhase,
        startNextServer: h.startNextServer,
        bindNotifier: vi.fn(),
        reportNativeCrash: vi.fn(),
        registerSecretCipher: h.registerSecretCipher,
        ...(h.withQuitHook ? { claimQuitSignals: h.claimQuitSignals, shutdownForQuit: h.shutdownForQuit } : {}),
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

describe("electron/main.ts: the quit runs libi's shutdown (EL-2)", () => {
  it("claims the quit signals before the server starts", async () => {
    await importMain();
    await (h.handlers.get("ready")!() as Promise<void>);
    expect(h.claimQuitSignals).toHaveBeenCalledTimes(1);
    expect(h.startNextServer).toHaveBeenCalledTimes(1);
    expect(h.claimQuitSignals.mock.invocationCallOrder[0]).toBeLessThan(h.startNextServer.mock.invocationCallOrder[0]);
  });

  it("before-quit holds the quit, runs shutdownForQuit, then quits", async () => {
    await importMain();
    await (h.handlers.get("ready")!() as Promise<void>);
    const e = { preventDefault: vi.fn() };
    (h.handlers.get("before-quit") as (e: unknown) => void)(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(h.shutdownForQuit).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.quit).toHaveBeenCalledTimes(1));
    expect(h.mainSyncLog).toHaveBeenCalledWith(expect.stringMatching(/libi's shutdown finished/));
  });

  it("an older runtime without the hook: no claim, and the quit is not held", async () => {
    h.withQuitHook = false;
    await importMain();
    await (h.handlers.get("ready")!() as Promise<void>);
    expect(h.claimQuitSignals).not.toHaveBeenCalled();
    const e = { preventDefault: vi.fn() };
    (h.handlers.get("before-quit") as (e: unknown) => void)(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(h.mainSyncLog).toHaveBeenCalledWith(expect.stringMatching(/predates shutdownForQuit/));
  });

  it("dev (no runtime in this process): the quit is not held", async () => {
    h.isPackaged = false;
    await importMain();
    const e = { preventDefault: vi.fn() };
    (h.handlers.get("before-quit") as (e: unknown) => void)(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe("electron/main.ts: launch never reads the keychain", () => {
  // Owner report 2026-09-29: the installed 0.1.16 asked for the login keychain
  // password at every launch. The boot called safeStorage.isEncryptionAvailable(),
  // which on macOS is a keychain read, for a user with no social grant at all.
  it("registers the keychain cipher before the server starts, without one safeStorage call", async () => {
    await importMain();
    await (h.handlers.get("ready")!() as Promise<void>);
    expect(h.registerSecretCipher).toHaveBeenCalledTimes(1);
    expect(h.registerSecretCipher.mock.invocationCallOrder[0]).toBeLessThan(h.startNextServer.mock.invocationCallOrder[0]);
    const cipher = h.registerSecretCipher.mock.calls[0][0] as { label: string; available: () => boolean };
    expect(cipher.label).toBe("keychain");
    expect(h.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(h.safeStorage.encryptString).not.toHaveBeenCalled();
    expect(h.safeStorage.decryptString).not.toHaveBeenCalled();
    // …and the keychain is asked the first time the runtime needs it.
    h.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    expect(cipher.available()).toBe(true);
    expect(h.safeStorage.isEncryptionAvailable).toHaveBeenCalledTimes(1);
  });
});
