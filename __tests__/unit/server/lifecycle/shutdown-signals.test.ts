/**
 * A signal-triggered shutdown must actually END the process.
 *
 * Registering a `process.on("SIGTERM")` handler replaces Node's default
 * disposition, which is to terminate. Until 2026-08-21 the handler cleaned up
 * and then simply returned, so the server survived its own shutdown in the
 * worst possible state: the port file deleted, the HTTP port still bound.
 *
 * Observed on published 0.1.2 during the FULL QA run — `kill <pid>` left the
 * server serving on 3499 with no port file, and the next `npx @nagellabs/libi`
 * died with `EADDRINUSE 127.0.0.1:3499`. In production, where no `LIBI_PORT`
 * is set and the port is ephemeral, the deleted file is worse still: every MCP
 * child falls back to `getCurrentPort()`'s 3456 default and addresses a server
 * that is not there.
 *
 * These tests exist so the process can never again outlive its own shutdown.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMcpHttpChild } from "@/lib/server/lifecycle/mcp-http-child";

const shutdown = vi.fn(async () => {});
vi.mock("@/lib/export/drivers", () => ({ pickDriver: () => ({ shutdown }) }));

const retireAllForExit = vi.fn();
vi.mock("@/lib/agents/process-manager", () => ({
  getProcessManager: () => ({ retireAllForExit }),
}));

let home: string;

vi.mock("@/lib/libi-home", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/libi-home")>();
  return {
    ...actual,
    getLibiPortFile: () => path.join(process.env.LIBI_TEST_SHUTDOWN_HOME!, "port"),
    getMcpPortFile: () => path.join(process.env.LIBI_TEST_SHUTDOWN_HOME!, "mcp-port"),
  };
});

type ShutdownSignal = "SIGTERM" | "SIGINT" | "SIGHUP";
const SIGNALS: ShutdownSignal[] = ["SIGTERM", "SIGINT", "SIGHUP"];

/** Fresh module instance — the `shuttingDown` latch is module-level state. */
async function loadAndInstall() {
  vi.resetModules();
  const mod = await import("@/lib/server/lifecycle/category-b");
  mod.writePortFileAndInstallSignals();
  return mod;
}

/** Run every handler registered for `signal`, awaiting async ones. */
async function raise(signal: ShutdownSignal) {
  const handlers = process.listeners(signal) as Array<() => unknown>;
  await Promise.all(handlers.map((h) => h()));
}

/** Make this process look like Electron's main process for the duration of `fn`. */
async function asElectronMain(fn: () => Promise<void>) {
  Object.defineProperty(process.versions, "electron", { value: "36.9.5", configurable: true });
  try {
    await fn();
  } finally {
    delete (process.versions as Record<string, string | undefined>).electron;
  }
}

describe("signal shutdown", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let portFile: string;
  // Each fresh import of the module graph adds process-level error listeners;
  // a case removes the ones it added so a dozen imports stay quiet.
  let uncaughtAtStart: NodeJS.UncaughtExceptionListener[];
  let rejectionAtStart: NodeJS.UnhandledRejectionListener[];

  beforeEach(() => {
    uncaughtAtStart = process.listeners("uncaughtException");
    rejectionAtStart = process.listeners("unhandledRejection");
    home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-shutdown-"));
    process.env.LIBI_TEST_SHUTDOWN_HOME = home;
    process.env.LIBI_PORT = "3499";
    portFile = path.join(home, "port");
    shutdown.mockClear();
    shutdown.mockImplementation(async () => {});
    retireAllForExit.mockClear();
    retireAllForExit.mockImplementation(() => {});
    // Must not actually exit the vitest worker.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((): never =>
      undefined as never) as typeof process.exit);
  });

  afterEach(() => {
    for (const listener of process.listeners("uncaughtException")) {
      if (!uncaughtAtStart.includes(listener)) process.removeListener("uncaughtException", listener);
    }
    for (const listener of process.listeners("unhandledRejection")) {
      if (!rejectionAtStart.includes(listener)) process.removeListener("unhandledRejection", listener);
    }
    for (const s of SIGNALS) process.removeAllListeners(s);
    process.removeAllListeners("exit");
    exitSpy.mockRestore();
    delete process.env.LIBI_TEST_SHUTDOWN_HOME;
    // Category B publishes this process's port here; it must not reach the next case.
    delete process.env.LIBI_SERVER_PORT;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("writes the port file on install", async () => {
    await loadAndInstall();
    expect(fs.readFileSync(portFile, "utf-8")).toBe("3499");
  });

  it.each(SIGNALS)("exits the process on %s", async (signal) => {
    await loadAndInstall();
    await raise(signal);

    // The whole point: the process must go down, not merely tidy up.
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(fs.existsSync(portFile)).toBe(false);
  });

  it("never deletes the port file without also exiting", async () => {
    // The 0.1.2 failure mode was precisely this pair coming apart: file gone,
    // process alive, port still bound.
    await loadAndInstall();
    await raise("SIGTERM");
    expect(fs.existsSync(portFile)).toBe(false);
    expect(exitSpy).toHaveBeenCalled();
  });

  it("exits even when the export driver rejects", async () => {
    shutdown.mockImplementation(async () => {
      throw new Error("chromium is wedged");
    });
    await loadAndInstall();
    await raise("SIGTERM");
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(fs.existsSync(portFile)).toBe(false);
  });

  it("exits even when the export driver never settles", async () => {
    // A hung Chromium must not be able to make Ctrl-C stop working.
    vi.useFakeTimers();
    shutdown.mockImplementation(() => new Promise<void>(() => {}));
    await loadAndInstall();
    const raised = raise("SIGTERM");
    await vi.advanceTimersByTimeAsync(3000);
    await raised;
    expect(exitSpy).toHaveBeenCalledWith(0);
    vi.useRealTimers();
  });

  it("is idempotent — a second signal does not re-run shutdown", async () => {
    await loadAndInstall();
    await raise("SIGTERM");
    await raise("SIGTERM");
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("a closed terminal's SIGHUP and the same stop passed on by the launcher, arriving together, shut down once and exit once", async () => {
    // A signal sent to the whole group reaches the server directly and again
    // through bin/libi.js, which passes SIGTERM and SIGHUP on to its child.
    await loadAndInstall();
    await Promise.all([raise("SIGHUP"), raise("SIGHUP"), raise("SIGTERM")]);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("inside Electron's main process SIGHUP is left to Electron's own quit, while SIGINT and SIGTERM still run this shutdown", async () => {
    await asElectronMain(async () => {
      const before = Object.fromEntries(SIGNALS.map((s) => [s, process.listenerCount(s)]));
      await loadAndInstall();
      expect(process.listenerCount("SIGHUP")).toBe(before.SIGHUP);
      expect(process.listenerCount("SIGINT")).toBe(before.SIGINT + 1);
      expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM + 1);
    });
  });

  it("names SIGHUP as a shutdown signal for a plain Node host only", async () => {
    const { shutdownSignals } = await import("@/lib/server/lifecycle/category-b");
    const node = { node: "24.16.0" } as NodeJS.ProcessVersions;
    const electron = { node: "22.20.0", electron: "36.9.5" } as NodeJS.ProcessVersions;
    expect(shutdownSignals(node)).toEqual(["SIGTERM", "SIGINT", "SIGHUP"]);
    expect(shutdownSignals(electron)).toEqual(["SIGTERM", "SIGINT"]);
  });

  it("retires every agent process synchronously, before the driver shutdown starts", async () => {
    // Ctrl-C sends SIGINT to libi's agent CLI children too. Retiring them
    // has to happen before anything else in the handler — including its own
    // first await — so a process exit that lands mid-shutdown is recognized
    // as part of this exit and never reported as a crash in an open chat.
    await loadAndInstall();
    const handlers = process.listeners("SIGTERM") as Array<() => unknown>;
    const pending = handlers[0]();
    // Synchronous checkpoint: nothing in the handler has awaited yet, so if
    // retireAllForExit were anything but the first statement, this call
    // order would catch it.
    expect(retireAllForExit).toHaveBeenCalledOnce();
    expect(shutdown).not.toHaveBeenCalled();
    await pending;
  });

  describe("port files belong to the instance that wrote them", () => {
    // Two libi processes on one home share `port` and `mcp-port`, and the one
    // that booted last owns both. An instance exiting must never delete what the
    // other published, or that instance's MCP children lose their server.
    async function installAndCaptureExit(mod?: typeof import("@/lib/server/lifecycle/category-b")) {
      const before = process.listeners("exit");
      const loaded = mod ?? (await loadAndInstall());
      // By name: the first logger transport in a worker also adds pino's own
      // `onExit` (on-exit-leak-free), so a case run on its own sees two.
      const added = process.listeners("exit").filter((l) => !before.includes(l) && l.name === "cleanupPortFile");
      expect(added).toHaveLength(1);
      return { mod: loaded, runExit: () => added[0](0) };
    }

    it("exit cleanup leaves a port file another instance has rewritten since", async () => {
      const { runExit } = await installAndCaptureExit();
      expect(fs.readFileSync(portFile, "utf-8")).toBe("3499");
      fs.writeFileSync(portFile, "55303");
      runExit();
      expect(fs.readFileSync(portFile, "utf-8")).toBe("55303");
    });

    it("exit cleanup removes a port file that still names this instance's port", async () => {
      const { runExit } = await installAndCaptureExit();
      runExit();
      expect(fs.existsSync(portFile)).toBe(false);
    });

    it("a signal shutdown leaves a port file another instance has rewritten since", async () => {
      await loadAndInstall();
      fs.writeFileSync(portFile, "55303");
      await raise("SIGTERM");
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(fs.readFileSync(portFile, "utf-8")).toBe("55303");
    });

    it("publishes this server's own port in LIBI_SERVER_PORT, so its in-process callers and every child it spawns resolve this server after another instance rewrites the port file", async () => {
      await loadAndInstall();
      expect(process.env.LIBI_SERVER_PORT).toBe("3499");
      fs.writeFileSync(portFile, "55303");
      const { getCurrentPort } = await import("@/lib/libi-home");
      expect(getCurrentPort()).toBe(3499);
    });

    /** A real aggregator supervisor over a fake child, publishing `mcp-port` in this test's home on 3457. */
    async function superviseAggregator(opts: { maxRestarts?: number } = {}) {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        exitCode: number | null;
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (signal?: string) => boolean;
      };
      child.pid = 4242;
      child.exitCode = null;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        child.exitCode = 0;
        child.emit("exit", 0, null);
        return true;
      };
      const handle = await startMcpHttpChild({
        spawn: (() => child) as never,
        fetch: (async () => new Response(JSON.stringify({ ok: true, healthToken: "t" }), { status: 200 })) as never,
        healthToken: () => "t",
        killTree: (c, signal) => {
          c.kill(signal);
        },
        signalGroup: () => {},
        entry: () => ({ command: "n", args: [], env: {} }),
        portFile: path.join(home, "mcp-port"),
        pickPort: async () => 3457,
        maxRestarts: opts.maxRestarts,
        restartDelayMs: 1,
      });
      return { handle, child };
    }

    it("exit cleanup removes mcp-port through the aggregator's own stop, synchronously, while this instance still owns it", async () => {
      const mcpPortFile = path.join(home, "mcp-port");
      const { mod, runExit } = await installAndCaptureExit();
      const { handle } = await superviseAggregator();
      mod.setMcpHttpChildForTests(handle);
      try {
        expect(fs.readFileSync(mcpPortFile, "utf-8")).toBe("3457");
        runExit();
        expect(handle.status()).toBe("stopped");
        expect(fs.existsSync(mcpPortFile)).toBe(false);
      } finally {
        mod.setMcpHttpChildForTests(null);
      }
    });

    it("exit cleanup leaves an mcp-port another instance has rewritten since", async () => {
      const mcpPortFile = path.join(home, "mcp-port");
      const { mod, runExit } = await installAndCaptureExit();
      const { handle } = await superviseAggregator();
      mod.setMcpHttpChildForTests(handle);
      try {
        fs.writeFileSync(mcpPortFile, "55304");
        runExit();
        expect(handle.status()).toBe("stopped");
        expect(fs.readFileSync(mcpPortFile, "utf-8")).toBe("55304");
      } finally {
        mod.setMcpHttpChildForTests(null);
      }
    });

    it("exit cleanup leaves an mcp-port another instance published on the same port number after this instance's aggregator gave up", async () => {
      const mcpPortFile = path.join(home, "mcp-port");
      const { mod, runExit } = await installAndCaptureExit();
      const { handle, child } = await superviseAggregator({ maxRestarts: 0 });
      mod.setMcpHttpChildForTests(handle);
      try {
        child.exitCode = 1;
        child.emit("exit", 1, null);
        expect(handle.status()).toBe("gave-up");
        expect(fs.existsSync(mcpPortFile)).toBe(false);
        // Another instance found 3457 free and published its own aggregator there.
        fs.writeFileSync(mcpPortFile, "3457");
        runExit();
        expect(fs.readFileSync(mcpPortFile, "utf-8")).toBe("3457");
      } finally {
        mod.setMcpHttpChildForTests(null);
      }
    });
  });

  it("still shuts down and exits when retireAllForExit throws", async () => {
    // A throw here must never disarm Ctrl-C or skip process.exit — retiring
    // the agent processes is a courtesy to the chat UI, not a precondition
    // for the server actually going down.
    retireAllForExit.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await loadAndInstall();
    await raise("SIGTERM");
    expect(retireAllForExit).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(fs.existsSync(portFile)).toBe(false);
  });
});
