import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The packaged app never waits for the shell-environment probe. `electron/main.ts`
 * is imported with `electron` and its sibling shell modules mocked; `bootstrapPath()` returns a
 * probe that NEVER settles; the captured `ready` handler is driven down the packaged path. Boot
 * must still reach `runtime.api.runInstallPhase` — while LIBI_SHELL_ENV still says `pending`.
 */
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  stateAtInstall: undefined as string | undefined,
  isPackaged: true,
  bootstrapPath: vi.fn(),
  runInstallPhase: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return h.isPackaged;
    },
    on: (event: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(event, fn);
    },
    getPath: () => "/tmp/libi-main-test-userdata",
    // This launch is the only one: it holds the single-instance lock.
    requestSingleInstanceLock: () => true,
    quit: vi.fn(),
    relaunch: vi.fn(),
    exit: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    disableHardwareAcceleration: vi.fn(),
    setPath: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  Notification: vi.fn(),
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
  dialog: { showErrorBox: vi.fn(), showOpenDialog: vi.fn() },
}));
vi.mock("../../../electron/libi-home-bootstrap", () => ({}));
vi.mock("../../../electron/path-bootstrap", () => ({ bootstrapPath: h.bootstrapPath }));
vi.mock("../../../electron/sync-log", () => ({ mainSyncLog: vi.fn(), createRendererConsoleForwarder: vi.fn() }));
vi.mock("../../../electron/nav-guard", () => ({ navigationDecision: vi.fn(), windowOpenExternal: vi.fn() }));
vi.mock("../../../electron/shell-updater", () => ({ initShellUpdater: vi.fn() }));
vi.mock("../../../electron/splash-window", () => ({
  createSplash: () => ({
    webContents: { once: (_event: string, cb: () => void) => cb(), send: vi.fn() },
    close: vi.fn(),
  }),
}));
vi.mock("../../../electron/runtime-loader", () => ({
  MIN_SHELL_API_VERSION: 1,
  MAX_SHELL_API_VERSION: 1,
  describeNoRuntimeFailure: vi.fn(),
  resolveRuntime: () => ({
    runtime: {
      version: "0.0.0-test",
      source: "bundled",
      root: "/nonexistent-runtime-root",
      api: { setRelaunchHandler: vi.fn(), electronAdapter: vi.fn(), runInstallPhase: h.runInstallPhase },
    },
    rejections: [],
    bundledVersion: "0.0.0-test",
  }),
}));

let envSnapshot: NodeJS.ProcessEnv;
let libiHome: string;

beforeEach(() => {
  envSnapshot = { ...process.env };
  libiHome = mkdtempSync(path.join(os.tmpdir(), "libi-main-no-await-"));
  process.env.LIBI_HOME = libiHome;
  h.stateAtInstall = undefined;
  h.isPackaged = true;
  h.bootstrapPath.mockImplementation(() => {
    process.env.LIBI_SHELL_ENV = "pending";
    return { probeSettled: new Promise<void>(() => {}) }; // never settles
  });
  h.runInstallPhase.mockImplementation(async () => {
    h.stateAtInstall = process.env.LIBI_SHELL_ENV;
    return { ok: false }; // stop the handler right here; the splash owns a failed install
  });
  // main.ts moves cwd into the runtime and installs process-wide crash handlers — neither
  // may touch the vitest worker.
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

describe("electron/main.ts — boot never waits for the shell environment", () => {
  it("reaches runInstallPhase while the probe is still pending", async () => {
    // A fresh import every time: a cached module from another case would skip the
    // module-scope bootstrapPath() call and leave that case's `ready` handler behind.
    vi.resetModules();
    h.handlers.clear();
    h.bootstrapPath.mockClear();
    h.runInstallPhase.mockClear();
    await import("../../../electron/main");
    expect(h.bootstrapPath).toHaveBeenCalledTimes(1);
    const ready = h.handlers.get("ready");
    expect(ready).toBeTypeOf("function");
    await ready!();
    expect(h.runInstallPhase).toHaveBeenCalledTimes(1);
    expect(h.stateAtInstall).toBe("pending");
  });

  it("dev (unpackaged) never calls bootstrapPath, so LIBI_SHELL_ENV stays absent (= inherited)", async () => {
    // The runtime reads an ABSENT LIBI_SHELL_ENV as inherited/loaded (no chat warning), which
    // is only true if the probe is gated to the packaged app. Module scope only — the dev `ready` handler would
    // poll a Next server.
    h.isPackaged = false;
    process.env.LIBI_CDP = "0";
    delete process.env.LIBI_SHELL_ENV;
    h.bootstrapPath.mockClear();
    vi.resetModules();
    await import("../../../electron/main");
    expect(h.bootstrapPath).not.toHaveBeenCalled();
    expect(process.env.LIBI_SHELL_ENV).toBeUndefined();
  });

  it("holds no probe handle: a bare bootstrapPath() statement, no probeSettled / shellEnvReady / LIBI_SHELL_ENV", () => {
    const src = readFileSync(path.join(process.cwd(), "electron/main.ts"), "utf8");
    expect(src).toMatch(/^\s*bootstrapPath\(\);$/m);
    expect(src).not.toMatch(/probeSettled|shellEnvReady|LIBI_SHELL_ENV/);
  });
});
