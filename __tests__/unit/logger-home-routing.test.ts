/**
 * Defect D2: `lib/logger.ts` resolved its pino destination at MODULE SCOPE.
 * In the bundled Electron MAIN process every transitively-imported module is
 * evaluated before `electron/main.ts` can assign
 * `process.env.LIBI_HOME = app.getPath("userData")`, so the whole of Category A
 * logged into the developer's `~/.libi` instead of the packaged home.
 *
 * The path is now resolved on FIRST WRITE in the Electron main process (and at
 * import everywhere else, unchanged) — see the module docblock for why the fix
 * is scoped that way.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let homeA: string;
let homeB: string;
let prevHome: string | undefined;

beforeEach(() => {
  // Each case needs its OWN logger module instance: the destination is opened
  // once per process by design, so a shared instance would carry the previous
  // test's file handle.
  vi.resetModules();
  prevHome = process.env.LIBI_HOME;
  homeA = fs.mkdtempSync(path.join(os.tmpdir(), "libi-log-a-"));
  homeB = fs.mkdtempSync(path.join(os.tmpdir(), "libi-log-b-"));
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = prevHome;
  restoreElectronMain();
  fs.rmSync(homeA, { recursive: true, force: true });
  fs.rmSync(homeB, { recursive: true, force: true });
});

type MutableProcess = NodeJS.Process & { type?: string };
let undoElectronMain: (() => void) | null = null;

/** Make this process look like the packaged Electron MAIN process. */
function pretendElectronMain(): void {
  const hadElectron = "electron" in process.versions;
  const prevType = (process as MutableProcess).type;
  Object.defineProperty(process.versions, "electron", {
    value: "36.9.5",
    configurable: true,
    writable: true,
  });
  (process as MutableProcess).type = "browser";
  undoElectronMain = () => {
    if (!hadElectron) delete (process.versions as Record<string, unknown>).electron;
    (process as MutableProcess).type = prevType;
  };
}

function restoreElectronMain(): void {
  undoElectronMain?.();
  undoElectronMain = null;
}

/** Wait for pino's async (setImmediate-batched) destination to hit disk. */
async function readLogEventually(home: string, timeoutMs = 3000): Promise<string> {
  const file = path.join(home, "logs", "libi.log");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const body = fs.readFileSync(file, "utf8");
      if (body.length > 0) return body;
    } catch {
      /* not created yet */
    }
    if (Date.now() > deadline) return "";
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("log destination in the Electron main process", () => {
  it("writes to the LIBI_HOME set AFTER the module was imported", async () => {
    pretendElectronMain();
    // Import with NO LIBI_HOME — the packaged-Electron ordering, where every
    // module is evaluated before main.ts knows its data root.
    delete process.env.LIBI_HOME;
    const { serverLogger } = await import("@/lib/logger");

    // …then the app declares its real home, exactly as electron/main.ts does.
    process.env.LIBI_HOME = homeA;
    serverLogger.info({ tag: "test", op: "d2_probe_a" }, "hello from home A");

    const body = await readLogEventually(homeA);
    expect(body, "no log file under the home declared after import").toContain("d2_probe_a");
  });

  it("opens once and does not chase later LIBI_HOME changes", async () => {
    pretendElectronMain();
    process.env.LIBI_HOME = homeA;
    const { serverLogger } = await import("@/lib/logger");
    serverLogger.info({ tag: "test", op: "d2_first" }, "first");
    expect(await readLogEventually(homeA)).toContain("d2_first");

    process.env.LIBI_HOME = homeB;
    serverLogger.info({ tag: "test", op: "d2_second" }, "second");
    await new Promise((r) => setTimeout(r, 200));

    expect(fs.existsSync(path.join(homeB, "logs", "libi.log"))).toBe(false);
    expect(fs.readFileSync(path.join(homeA, "logs", "libi.log"), "utf8")).toContain("d2_second");
  });
});

describe("log destination in every other process", () => {
  it("pins the path at import — a later LIBI_HOME is NOT followed", async () => {
    // The Next.js server / MCP child / CLI all inherit LIBI_HOME from their
    // parent before they start, so import-time resolution is correct there —
    // and deferring would let a transient LIBI_HOME (a test's temp dir) capture
    // the log file and race its own teardown.
    process.env.LIBI_HOME = homeA;
    const { serverLogger } = await import("@/lib/logger");

    process.env.LIBI_HOME = homeB;
    serverLogger.info({ tag: "test", op: "d2_pinned" }, "pinned");

    expect(await readLogEventually(homeA)).toContain("d2_pinned");
    expect(fs.existsSync(path.join(homeB, "logs", "libi.log"))).toBe(false);
  });

  it("recreates a log dir deleted between import and first write — the open is synchronous, never a latent async race", async () => {
    // Regression for the CI suite hang (2026-08-14): the destination used to
    // be opened by SonicBoom asynchronously (`{ dest: path, sync: false,
    // mkdir: true }`), so a directory deleted after `pino.destination()`
    // returned but before the async mkdir+open landed left the stream latched
    // on fd -1 forever — every later write threw ERR_OUT_OF_RANGE and pino's
    // exit hooks ran against a stream that could never become ready. Vitest
    // workers hit exactly that window (tests point LIBI_HOME at a temp dir
    // and delete it in afterEach) and wedged instead of exiting.
    // `openDestination()` now re-runs ensureLibiDirs() and opens the fd with
    // openSync BEFORE handing it to SonicBoom: either the write lands, or the
    // failure is synchronous and latched. No in-between state exists.
    process.env.LIBI_HOME = homeA;
    const { serverLogger } = await import("@/lib/logger");

    // Import already created homeA/logs; simulate the deletion window before
    // the first write opens the destination.
    fs.rmSync(homeA, { recursive: true, force: true });

    expect(() => serverLogger.info({ tag: "test", op: "race_first" }, "first")).not.toThrow();
    expect(await readLogEventually(homeA), "write after dir deletion must land").toContain(
      "race_first",
    );

    expect(() => serverLogger.info({ tag: "test", op: "race_second" }, "second")).not.toThrow();
    const deadline = Date.now() + 3000;
    let body = "";
    while (Date.now() < deadline && !body.includes("race_second")) {
      body = await readLogEventually(homeA);
      if (!body.includes("race_second")) await new Promise((r) => setTimeout(r, 25));
    }
    expect(body).toContain("race_second");
  });

  it("never throws out of a log call when its destination is gone", async () => {
    process.env.LIBI_HOME = homeA;
    const { serverLogger } = await import("@/lib/logger");
    serverLogger.info({ tag: "test", op: "d2_before" }, "before");
    await readLogEventually(homeA);

    // A deleted log directory used to surface as a synchronous SonicBoom throw
    // out of `logger.info()`, turning healthy request handlers into 500s.
    fs.rmSync(homeA, { recursive: true, force: true });
    expect(() => serverLogger.info({ tag: "test", op: "d2_after" }, "after")).not.toThrow();
  });
});

describe("log destination open failure (M7)", () => {
  it("latches a synchronous open failure instead of retrying ensureLibiDirs on every write", async () => {
    // Only the Electron main process defers `ensureLibiDirs()` into
    // `openDestination()` (see the module docblock) — everywhere else it runs
    // once at import time, before any write is even possible. So this is the
    // one path where a SYNCHRONOUS open failure (EACCES/EROFS on the app's
    // data root) can repeat on every `logger.info()` call rather than once at
    // import.
    pretendElectronMain();
    process.env.LIBI_HOME = homeA;

    const ensureLibiDirsSpy = vi.fn(() => {
      throw new Error("EACCES: permission denied, mkdir");
    });
    vi.doMock("@/lib/libi-home", async () => {
      const actual = await vi.importActual<typeof import("@/lib/libi-home")>("@/lib/libi-home");
      return { ...actual, ensureLibiDirs: ensureLibiDirsSpy };
    });

    try {
      const { serverLogger } = await import("@/lib/logger");

      // None of these may throw — a broken log destination must never turn a
      // healthy call site into an exception.
      expect(() => serverLogger.info({ tag: "test", op: "m7_first" }, "first")).not.toThrow();
      expect(() => serverLogger.info({ tag: "test", op: "m7_second" }, "second")).not.toThrow();
      expect(() => serverLogger.info({ tag: "test", op: "m7_third" }, "third")).not.toThrow();

      // The real assertion: exactly ONE attempt. Before the latch, each of the
      // three calls above would have re-run ensureLibiDirs() (plus a statSync
      // and a fresh pino.destination()) from scratch.
      expect(ensureLibiDirsSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("@/lib/libi-home");
    }
  });
});
