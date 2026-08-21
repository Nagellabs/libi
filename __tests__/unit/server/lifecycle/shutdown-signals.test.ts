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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const shutdown = vi.fn(async () => {});
vi.mock("@/lib/export/drivers", () => ({ pickDriver: () => ({ shutdown }) }));

let home: string;

vi.mock("@/lib/libi-home", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/libi-home")>();
  return {
    ...actual,
    getLibiPortFile: () => path.join(process.env.LIBI_TEST_SHUTDOWN_HOME!, "port"),
  };
});

/** Fresh module instance — the `shuttingDown` latch is module-level state. */
async function loadAndInstall() {
  vi.resetModules();
  const mod = await import("@/lib/server/lifecycle/category-b");
  mod.writePortFileAndInstallSignals();
  return mod;
}

/** Run every handler registered for `signal`, awaiting async ones. */
async function raise(signal: "SIGTERM" | "SIGINT") {
  const handlers = process.listeners(signal) as Array<() => unknown>;
  await Promise.all(handlers.map((h) => h()));
}

describe("signal shutdown", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let portFile: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-shutdown-"));
    process.env.LIBI_TEST_SHUTDOWN_HOME = home;
    process.env.LIBI_PORT = "3499";
    portFile = path.join(home, "port");
    shutdown.mockClear();
    shutdown.mockImplementation(async () => {});
    // Must not actually exit the vitest worker.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((): never =>
      undefined as never) as typeof process.exit);
  });

  afterEach(() => {
    for (const s of ["SIGTERM", "SIGINT"] as const) process.removeAllListeners(s);
    process.removeAllListeners("exit");
    exitSpy.mockRestore();
    delete process.env.LIBI_TEST_SHUTDOWN_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("writes the port file on install", async () => {
    await loadAndInstall();
    expect(fs.readFileSync(portFile, "utf-8")).toBe("3499");
  });

  it.each(["SIGTERM", "SIGINT"] as const)("exits the process on %s", async (signal) => {
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
});
