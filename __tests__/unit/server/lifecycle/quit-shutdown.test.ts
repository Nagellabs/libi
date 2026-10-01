/**
 * EL-2: in the desktop app, SIGINT and SIGTERM quit through Electron, and
 * Electron's quit runs libi's shutdown.
 *
 * A Node listener added after `ready` REPLACES Electron's own graceful quit on
 * a signal: libi's shutdown ran, but Chromium's teardown, `before-quit` and
 * `will-quit` did not. And the other way round, an Electron quit (Cmd-Q, the
 * last window closed) ran none of libi's shutdown — only the `exit` listener's
 * port-file cleanup.
 *
 * So a shell that has the hook CLAIMS the quit signals (`claimQuitSignals`,
 * before the server starts) and calls `shutdownForQuit()` from `before-quit`;
 * Category B then installs no SIGINT/SIGTERM listener. A shell without the hook
 * (an older one) never claims, and npx is not Electron: both keep today's
 * listeners, exactly. The claim and the shutdown live on `globalThis`, because
 * the shell loads `dist-cli`'s copy of these modules while Category B runs in
 * Next's own bundle (lib/server/lifecycle/relaunch.ts explains the split).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const shutdown = vi.fn(async () => {});
vi.mock("@/lib/export/drivers", () => ({ pickDriver: () => ({ shutdown }) }));
const retireAllForExit = vi.fn();
vi.mock("@/lib/agents/process-manager", () => ({ getProcessManager: () => ({ retireAllForExit }) }));
vi.mock("@/lib/libi-home", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/libi-home")>();
  return {
    ...actual,
    getLibiPortFile: () => path.join(process.env.LIBI_TEST_QUIT_HOME!, "port"),
    getMcpPortFile: () => path.join(process.env.LIBI_TEST_QUIT_HOME!, "mcp-port"),
  };
});

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
const electron = { node: "22.20.0", electron: "36.9.5" } as NodeJS.ProcessVersions;
const node = { node: "24.16.0" } as NodeJS.ProcessVersions;

let home: string;
let portFile: string;
let exitSpy: ReturnType<typeof vi.spyOn>;
let listenersAtStart: Record<string, number>;

async function asElectronMain<T>(fn: () => Promise<T>): Promise<T> {
  Object.defineProperty(process.versions, "electron", { value: "36.9.5", configurable: true });
  try {
    return await fn();
  } finally {
    delete (process.versions as Record<string, string | undefined>).electron;
  }
}

/** Fresh module graph (the latches are module state), then Category B's install. */
async function loadAndInstall() {
  vi.resetModules();
  const quit = await import("@/lib/server/lifecycle/quit");
  const catB = await import("@/lib/server/lifecycle/category-b");
  return { quit, catB };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-quit-"));
  process.env.LIBI_TEST_QUIT_HOME = home;
  process.env.LIBI_PORT = "3499";
  portFile = path.join(home, "port");
  shutdown.mockReset();
  shutdown.mockImplementation(async () => {});
  retireAllForExit.mockReset();
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((): never => undefined as never) as typeof process.exit);
  listenersAtStart = Object.fromEntries(SIGNALS.map((s) => [s, process.listenerCount(s)]));
  const slot = globalThis as Record<string, unknown>;
  delete slot.__libiQuitShutdown;
  delete slot.__libiShellOwnsQuitSignals;
});
afterEach(() => {
  for (const s of SIGNALS) process.removeAllListeners(s);
  process.removeAllListeners("exit");
  exitSpy.mockRestore();
  delete process.env.LIBI_TEST_QUIT_HOME;
  delete process.env.LIBI_SERVER_PORT;
  const slot = globalThis as Record<string, unknown>;
  delete slot.__libiQuitShutdown;
  delete slot.__libiShellOwnsQuitSignals;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("shutdownSignals", () => {
  it("Electron with a shell that claimed the quit signals: none — they go through Electron's quit", async () => {
    const { catB } = await loadAndInstall();
    expect(catB.shutdownSignals(electron, true)).toEqual([]);
  });

  it("Electron under a shell without the hook: SIGTERM + SIGINT, as today", async () => {
    const { catB } = await loadAndInstall();
    expect(catB.shutdownSignals(electron, false)).toEqual(["SIGTERM", "SIGINT"]);
  });

  it("plain Node (npx) ignores a claim: all three", async () => {
    const { catB } = await loadAndInstall();
    expect(catB.shutdownSignals(node, true)).toEqual(["SIGTERM", "SIGINT", "SIGHUP"]);
  });

  it("the default reads the claim from the shared slot", async () => {
    const { quit, catB } = await loadAndInstall();
    expect(catB.shutdownSignals(electron)).toEqual(["SIGTERM", "SIGINT"]);
    quit.claimQuitSignals();
    expect(quit.shellOwnsQuitSignals()).toBe(true);
    expect(catB.shutdownSignals(electron)).toEqual([]);
  });
});

describe("shutdownForQuit", () => {
  it("claimed Electron main: Category B adds no signal listener, and shutdownForQuit runs the full shutdown WITHOUT exiting", async () => {
    await asElectronMain(async () => {
      const { quit, catB } = await loadAndInstall();
      quit.claimQuitSignals();
      catB.writePortFileAndInstallSignals();
      for (const s of SIGNALS) expect(process.listenerCount(s), s).toBe(listenersAtStart[s]);
      expect(fs.readFileSync(portFile, "utf-8")).toBe("3499");

      await expect(quit.shutdownForQuit()).resolves.toBe(true);
      expect(retireAllForExit).toHaveBeenCalledTimes(1);
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(portFile)).toBe(false);
      // Electron exits the process itself once its quit completes.
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  it("the shell's copy of the module reaches Category B's shutdown through globalThis (two module instances)", async () => {
    await asElectronMain(async () => {
      const { catB } = await loadAndInstall();
      (await import("@/lib/server/lifecycle/quit")).claimQuitSignals();
      catB.writePortFileAndInstallSignals();
      vi.resetModules();
      const shellCopy = await import("@/lib/server/lifecycle/quit");
      await expect(shellCopy.shutdownForQuit()).resolves.toBe(true);
      expect(shutdown).toHaveBeenCalledTimes(1);
    });
  });

  it("called twice, or concurrently: one shutdown, both resolve", async () => {
    await asElectronMain(async () => {
      const { quit, catB } = await loadAndInstall();
      quit.claimQuitSignals();
      catB.writePortFileAndInstallSignals();
      await Promise.all([quit.shutdownForQuit(), quit.shutdownForQuit()]);
      await quit.shutdownForQuit();
      expect(shutdown).toHaveBeenCalledTimes(1);
    });
  });

  it("before Category B registered anything: resolves false, throws nothing", async () => {
    const { quit } = await loadAndInstall();
    await expect(quit.shutdownForQuit()).resolves.toBe(false);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("an unclaimed Electron main (older shell) keeps the SIGTERM path, and it still exits", async () => {
    await asElectronMain(async () => {
      const { catB } = await loadAndInstall();
      catB.writePortFileAndInstallSignals();
      expect(process.listenerCount("SIGTERM")).toBe(listenersAtStart.SIGTERM + 1);
      await Promise.all((process.listeners("SIGTERM") as Array<() => unknown>).map((fn) => fn()));
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  it("a signal after a quit shutdown does not run it again, and still exits the process", async () => {
    const { quit, catB } = await loadAndInstall();
    catB.writePortFileAndInstallSignals();
    await quit.shutdownForQuit();
    expect(exitSpy).not.toHaveBeenCalled();
    await Promise.all((process.listeners("SIGTERM") as Array<() => unknown>).map((fn) => fn()));
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
