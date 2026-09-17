import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb } from "../../helpers/test-db";

/**
 * The exact non-TTY format, read out of
 * node_modules/playwright-core/lib/server/registry/browserFetcher.js
 * (`getBasicDownloadProgress`, playwright-core 1.59.1):
 *
 *   const totalRows = 10, stepWidth = 8;
 *   const percentageString = String(percentage * 100 | 0).padStart(3);
 *   console.log(`|${"■".repeat(row*stepWidth)}${" ".repeat((totalRows-row)*stepWidth)}| ${percentageString}% of ${toMegabytes(totalBytes)}`);
 *   function toMegabytes(bytes) { return `${Math.round(bytes/1024/1024*10)/10} MiB`; }
 *
 * So: an 80-char bar between two pipes, then a space, then a RIGHT-ALIGNED
 * 3-wide percent, then "% of ", then MiB with one decimal. `process.stdout.isTTY`
 * is false for a spawned child, so this — not the animated bar — is what libi
 * sees. Eleven lines per archive (rows 0..10). The spec's `|■■■■■■■■  50% of
 * 165 MB|` is wrong in three ways (closing pipe position, bar width, MB vs MiB)
 * and these cases are the correction.
 *
 * Units: Playwright prints MiB (2^20 bytes); everything libi shows says "MB".
 * The parser converts at the boundary — MiB → bytes → decimal MB — so the
 * agent's "~173 MB" disclosure and the bar's total agree.
 */

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

// The real `playwright-chromium` installer's verify() asks playwright-core for
// the executable path; drive that from a variable so "not installed" →
// "installed" flips exactly when the fake CLI child says it finished.
const pw = vi.hoisted(() => ({ executablePath: "" }));
vi.mock("playwright-core", () => ({
  chromium: { executablePath: () => pw.executablePath },
}));

vi.mock("@/lib/runtime/node-runtime", () => ({
  resolveNodeCommand: () => "/fake/bin/node",
}));

const spawn = vi.hoisted(() => vi.fn());
// `<resolveNodeCommand()> --version`: the version the failure message and
// log name is the SPAWNED node's, not this process's (under the packaged app
// they differ — Electron's Node vs `<LIBI_HOME>/bin/node`).
const execFile = vi.hoisted(() => vi.fn());
// Registered under both specifiers: whether vitest keys "node:child_process"
// and "child_process" as one module id depends on the vite server's resolution
// cache, i.e. on which files ran before this one in the worker. Either way the
// spawn ensure-chromium reaches must be THIS fake — the alternative is a real
// 173 MB download into the test's temp cache.
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn,
  execFile,
}));
vi.mock("child_process", async (orig) => ({
  ...(await orig<typeof import("child_process")>()),
  spawn,
  execFile,
}));

// The dep transitions go through the leaf writer, not the DependencyManager
// class (which would be an import cycle now that retryDep calls back here).
const persisted = vi.hoisted(() => ({ transitions: [] as Array<Record<string, unknown>> }));
vi.mock("@/mcp/registry/dep-transition", () => ({
  writeDepTransition: vi.fn((mcpId: string, binary: string, patch: Record<string, unknown>) => {
    persisted.transitions.push({ mcpId, binary, ...patch });
  }),
  readDepTransition: vi.fn(() => null),
}));

// Only the export logger is faked — the failure log is part of the contract.
vi.mock("@/lib/logger", async (orig) => ({
  ...(await orig<typeof import("@/lib/logger")>()),
  exportLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getDb } from "@/lib/db/client";
import { exportLogger } from "@/lib/logger";
import { seedDatabase } from "@/lib/db/init";
import { playwrightChromiumRevision } from "@/lib/playwright/paths";
import { LIBI_INSTALLED_MARKER } from "@/lib/server/lifecycle/housekeeping";
import {
  CHROMIUM_DEP_BINARY,
  CHROMIUM_DOWNLOAD_MB,
  CHROMIUM_DOWNLOAD_MIB,
  CHROMIUM_MCP_ID,
  chromiumInstalled,
  chromiumInstallInFlight,
  ensureChromium,
  mibToMb,
  parsePlaywrightProgressLine,
  _resetSpawnedNodeVersionCache,
  _resetChromiumInstallState,
} from "@/lib/export/ensure-chromium";

const SPAWNED_NODE = "v24.18.0";

/** Make the stubbed `node --version` answer (or fail). */
function stubNodeVersion(answer: string | Error): void {
  execFile.mockReset().mockImplementation((...args: unknown[]) => {
    const cb = args.at(-1) as (err: Error | null, stdout: string, stderr: string) => void;
    if (answer instanceof Error) cb(answer, "", "");
    else cb(null, `${answer}\n`, "");
  });
}

const bar = (row: number) => "■".repeat(row * 8) + " ".repeat((10 - row) * 8);

/** Bytes of an archive Playwright reports as `${mib} MiB`. */
const mibBytes = (mib: number) => Math.round(mib * 1024 * 1024);

describe("parsePlaywrightProgressLine", () => {
  it("parses a zero-percent line", () => {
    expect(parsePlaywrightProgressLine(`|${bar(0)}|   0% of 165.1 MiB`)).toEqual({
      percent: 0,
      totalMb: mibToMb(165.1),
    });
  });

  it("parses a mid-download line", () => {
    expect(parsePlaywrightProgressLine(`|${bar(5)}|  50% of 165.1 MiB`)).toEqual({
      percent: 50,
      totalMb: mibToMb(165.1),
    });
  });

  it("parses the final line", () => {
    expect(parsePlaywrightProgressLine(`|${bar(10)}| 100% of 165.1 MiB`)).toEqual({
      percent: 100,
      totalMb: mibToMb(165.1),
    });
  });

  it("converts MiB to decimal MB at the boundary (165.5 MiB is 173.5 MB, not 165.5)", () => {
    // 165.5 × 1,048,576 = 173,539,328 bytes = 173.539328 MB.
    expect(mibToMb(165.5)).toBeCloseTo(173.539328, 6);
    const parsed = parsePlaywrightProgressLine(`|${bar(10)}| 100% of 165.5 MiB`)!;
    expect(parsed.totalMb).toBeCloseTo(173.5, 1);
    expect(Math.round(parsed.totalMb)).toBe(174);
  });

  it("the disclosure constant is Playwright's MiB figure converted the same way", () => {
    // Real 1.59.1 lines say `165.1 MiB`; the constant is derived from 165 MiB
    // so the "~173 MB" the agent quotes and the "173/173 MB" bar agree.
    expect(CHROMIUM_DOWNLOAD_MIB).toBe(165);
    expect(CHROMIUM_DOWNLOAD_MB).toBe(Math.round(mibToMb(CHROMIUM_DOWNLOAD_MIB)));
    expect(CHROMIUM_DOWNLOAD_MB).toBe(173);
    const real = parsePlaywrightProgressLine(`|${bar(10)}| 100% of 165.1 MiB`)!;
    expect(Math.round(real.totalMb)).toBe(CHROMIUM_DOWNLOAD_MB);
  });

  it("ignores Playwright's other stdout lines", () => {
    expect(
      parsePlaywrightProgressLine(
        "Downloading Chrome for Testing 147.0.7727.15 (playwright chromium v1217) from https://cdn.playwright.dev/...",
      ),
    ).toBeNull();
    expect(parsePlaywrightProgressLine("")).toBeNull();
    expect(parsePlaywrightProgressLine("| 50% of 165 MB|")).toBeNull();
  });
});

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

/** Let PassThrough deliver what was written before the child "closes". */
const flush = () => new Promise<void>((r) => setImmediate(r));

const TIMEOUT_MS = 10 * 60_000;

function failedLogs(): Array<Record<string, unknown>> {
  return vi
    .mocked(exportLogger.warn)
    .mock.calls.map(([fields]) => fields as Record<string, unknown>)
    .filter((f) => f.op === "ensure_chromium_failed");
}

describe("ensureChromium", () => {
  let tmp: string;
  let cache: string;
  let prevBrowsersPath: string | undefined;
  let transitions: Array<Record<string, unknown>>;
  let revision: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-ensure-chromium-"));
    cache = path.join(tmp, "ms-playwright");
    fs.mkdirSync(cache, { recursive: true });
    prevBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
    pw.executablePath = path.join(cache, "chromium-x", "chrome");
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    seedDatabase(db as never);
    persisted.transitions.length = 0;
    transitions = persisted.transitions;
    spawn.mockReset();
    stubNodeVersion(SPAWNED_NODE);
    _resetSpawnedNodeVersionCache();
    // The flight and the last-completed stamp are module-level by design; a
    // test that leaves either set would silently steer the next one.
    _resetChromiumInstallState();
    vi.mocked(exportLogger.warn).mockClear();
    vi.mocked(exportLogger.info).mockClear();
    revision = playwrightChromiumRevision()!;
    expect(revision).toMatch(/^\d+$/);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = prevBrowsersPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** What a successful `playwright install chromium --no-shell` leaves behind. */
  function layDownChromium(): void {
    const dir = path.join(cache, `chromium-${revision}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "INSTALLATION_COMPLETE"), "");
    pw.executablePath = path.join(dir, "chrome");
    fs.writeFileSync(pw.executablePath, "");
  }

  it("resolves at once, spawning nothing, when Chromium is already on disk", async () => {
    layDownChromium();
    expect(await chromiumInstalled()).toBe(true);
    await ensureChromium();
    expect(spawn).not.toHaveBeenCalled();
    expect(transitions).toEqual([]);
  });

  it("spawns a real node on playwright-core's CLI with --no-shell, reports bytes, and marks the revision libi-installed", async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const progress: Array<{ doneMb: number; totalMb: number }> = [];

    const run = ensureChromium({ onProgress: (p) => progress.push(p) });
    await flush();

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, opts] = spawn.mock.calls[0]!;
    expect(command).toBe("/fake/bin/node");
    expect(args[0]).toMatch(/node_modules[\\/]playwright-core[\\/]cli\.js$/);
    expect(args.slice(1)).toEqual(["install", "chromium", "--no-shell"]);
    expect(opts).toMatchObject({ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

    child.stdout.write(
      "Downloading Chromium 147.0.7727.15 (playwright build v1217) from https://cdn.playwright.dev/x\n",
    );
    child.stdout.write(`|${bar(0)}|   0% of 165.1 MiB\n`);
    child.stdout.write(`|${bar(5)}|  50% of 165.1 MiB\n`);
    // A chunk boundary in the middle of a line must not produce a bogus tick.
    child.stdout.write(`|${bar(10)}| 100% of `);
    child.stdout.write("165.1 MiB\n");
    await flush();
    layDownChromium();
    child.emit("close", 0);
    await run;

    // 165.1 MiB = 173,119,898 bytes = 173 MB; half of it rounds to 87 MB.
    const total = mibBytes(165.1);
    const half = Math.round(total / 2);
    expect(progress).toEqual([
      { doneMb: 0, totalMb: 173 },
      { doneMb: 87, totalMb: 173 },
      { doneMb: 173, totalMb: 173 },
    ]);

    // The Settings chip polls dependencyStatus: installing (with bytes) → installed.
    expect(transitions[0]).toMatchObject({
      mcpId: CHROMIUM_MCP_ID,
      binary: CHROMIUM_DEP_BINARY,
      runtimeStatus: "installing",
      error: null,
    });
    const withBytes = transitions.filter((t) => typeof t.bytesDownloaded === "number");
    expect(withBytes.map((t) => [t.bytesDownloaded, t.bytesTotal])).toEqual([
      [0, total],
      [half, total],
      [total, total],
    ]);
    expect(transitions.at(-1)).toMatchObject({
      runtimeStatus: "installed",
      installed: true,
      source: "bundled",
    });
    expect(failedLogs()).toEqual([]);

    // The prune (housekeeping.ts) removes only marked revisions.
    expect(
      fs.existsSync(path.join(cache, `chromium-${revision}`, LIBI_INSTALLED_MARKER)),
    ).toBe(true);
    // --no-shell: nothing was fetched for the headless shell, so nothing is
    // claimed for it either.
    expect(fs.existsSync(path.join(cache, `chromium_headless_shell-${revision}`))).toBe(false);
  });

  it("fails with the stderr tail, writes `failed`, logs the failure with the exit code, and marks nothing when the CLI exits non-zero", async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    // Simulate the CLI having created the revision dir before dying mid-way:
    // the marker must still not be written — a failed install is not libi's
    // browser, it is a partial download Playwright will resume.
    fs.mkdirSync(path.join(cache, `chromium-${revision}`), { recursive: true });

    const run = ensureChromium();
    await flush();
    child.stderr.write("Error: connect ECONNRESET cdn.playwright.dev\n");
    await flush();
    child.emit("close", 1, null);

    await expect(run).rejects.toThrow(/exited 1: Error: connect ECONNRESET/);
    expect(transitions.at(-1)).toMatchObject({
      runtimeStatus: "failed",
      error: expect.stringMatching(/ECONNRESET/),
    });
    expect(
      fs.existsSync(path.join(cache, `chromium-${revision}`, LIBI_INSTALLED_MARKER)),
    ).toBe(false);
    expect(failedLogs()).toEqual([
      expect.objectContaining({
        tag: "export",
        op: "ensure_chromium_failed",
        reason: "exit",
        exitCode: 1,
        signal: null,
        nodeVersion: SPAWNED_NODE,
        elapsedMs: expect.any(Number),
      }),
    ]);
  });

  it("refuses to declare success when the CLI exits 0 but no executable appeared", async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const run = ensureChromium();
    await flush();
    child.emit("close", 0, null);
    await expect(run).rejects.toThrow(/exited 0 but chromium\.executablePath\(\) still does not exist/);
    expect(transitions.at(-1)).toMatchObject({ runtimeStatus: "failed" });
    expect(failedLogs()).toEqual([
      expect.objectContaining({ reason: "verify", exitCode: 0, nodeVersion: SPAWNED_NODE }),
    ]);
  });

  it("SIGKILLs the child and rejects when the export's signal aborts", async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const ac = new AbortController();
    const run = ensureChromium({ signal: ac.signal });
    await flush();
    ac.abort();
    await expect(run).rejects.toThrow(/chromium install cancelled/);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(transitions.at(-1)).toMatchObject({ runtimeStatus: "failed" });
    expect(failedLogs()).toEqual([expect.objectContaining({ reason: "cancelled" })]);
  });

  it("polls shouldCancel between lines and kills the child when it flips", async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      spawn.mockReturnValue(child);
      let cancel = false;
      const run = ensureChromium({ shouldCancel: () => cancel });
      const settled = run.catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(600);
      expect(child.kill).not.toHaveBeenCalled();
      cancel = true;
      await vi.advanceTimersByTimeAsync(600);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(await settled).toMatchObject({ message: "chromium install cancelled" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the known Node 24.16.0 extractor hang and the Settings retry when the 10-minute timeout fires", async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      spawn.mockReturnValue(child);
      const run = ensureChromium();
      const settled = run.catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      const err = (await settled) as Error;
      expect(err.message).toBe(
        `Chromium download did not finish within 10 min (Node ${SPAWNED_NODE}). Known cause: Node 24.16.0 hangs Playwright's extractor — use Node 24.18.0 or newer, then retry the download under Settings → Canvas export (Chromium).`,
      );
      expect(transitions.at(-1)).toMatchObject({ runtimeStatus: "failed", error: err.message });
      expect(failedLogs()).toEqual([
        expect.objectContaining({
          reason: "timeout",
          nodeVersion: SPAWNED_NODE,
          elapsedMs: TIMEOUT_MS,
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("the node it names", () => {
    it("asks the spawned node for its version once per process, with a short timeout", async () => {
      const first = makeChild();
      spawn.mockReturnValueOnce(first);
      const runA = ensureChromium();
      await flush();
      expect(execFile).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = execFile.mock.calls[0]! as [string, string[], { timeout?: number }];
      expect(cmd).toBe("/fake/bin/node");
      expect(args).toEqual(["--version"]);
      expect(opts.timeout).toBeGreaterThan(0);
      expect(opts.timeout).toBeLessThanOrEqual(10_000);
      first.emit("close", 1, null);
      await expect(runA).rejects.toThrow(/exited 1/);
      expect(failedLogs().at(-1)).toMatchObject({ nodeVersion: SPAWNED_NODE });

      // Cached: a second flight does not probe again.
      const second = makeChild();
      spawn.mockReturnValueOnce(second);
      const runB = ensureChromium();
      await flush();
      expect(execFile).toHaveBeenCalledTimes(1);
      second.emit("close", 1, null);
      await expect(runB).rejects.toThrow(/exited 1/);
    });

    it("falls back to this process's version, marked (host), when the probe fails", async () => {
      stubNodeVersion(new Error("ENOENT"));
      vi.useFakeTimers();
      try {
        const child = makeChild();
        spawn.mockReturnValue(child);
        const run = ensureChromium();
        const settled = run.catch((e: Error) => e);
        await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
        const err = (await settled) as Error;
        expect(err.message).toContain(`(Node ${process.version} (host))`);
        expect(failedLogs()).toEqual([
          expect.objectContaining({ reason: "timeout", nodeVersion: `${process.version} (host)` }),
        ]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("force (the Settings Re-download)", () => {
    it("re-downloads over an existing install, passing --force only then", async () => {
      layDownChromium();
      const child = makeChild();
      spawn.mockReturnValue(child);
      const run = ensureChromium({ force: true });
      await flush();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect((spawn.mock.calls[0]![1] as string[]).slice(1)).toEqual([
        "install",
        "chromium",
        "--no-shell",
        "--force",
      ]);
      child.emit("close", 0, null);
      await expect(run).resolves.toBeUndefined();
      expect(transitions.at(-1)).toMatchObject({ runtimeStatus: "installed" });
    });

    it("a forced call arriving during a plain download joins it rather than forcing a second one", async () => {
      const child = makeChild();
      spawn.mockReturnValue(child);
      const plain = ensureChromium();
      await flush();
      const forced = ensureChromium({ force: true });
      await flush();
      expect(spawn).toHaveBeenCalledTimes(1);
      layDownChromium();
      child.emit("close", 0, null);
      await Promise.all([plain, forced]);
    });
  });

  describe("chromiumInstallInFlight (what the Settings chip reads)", () => {
    it("is null when idle, empty before the first tick, carries bytes after one, and null again when done", async () => {
      expect(chromiumInstallInFlight()).toBeNull();
      const child = makeChild();
      spawn.mockReturnValue(child);
      const run = ensureChromium();
      await flush();
      expect(chromiumInstallInFlight()).toEqual({});
      child.stdout.write(`|${bar(5)}|  50% of 165.1 MiB\n`);
      await flush();
      const total = mibBytes(165.1);
      expect(chromiumInstallInFlight()).toEqual({
        bytesDownloaded: Math.round(total / 2),
        bytesTotal: total,
      });
      layDownChromium();
      child.emit("close", 0, null);
      await run;
      expect(chromiumInstallInFlight()).toBeNull();
    });

    it("is null again after a failed flight", async () => {
      const child = makeChild();
      spawn.mockReturnValue(child);
      const run = ensureChromium();
      await flush();
      child.emit("close", 1, null);
      await expect(run).rejects.toThrow();
      expect(chromiumInstallInFlight()).toBeNull();
    });
  });

  it("discloses the approximate size the agent and UI quote", () => {
    expect(CHROMIUM_DOWNLOAD_MB).toBe(173);
    expect(CHROMIUM_MCP_ID).toBe("libi-export");
    expect(CHROMIUM_DEP_BINARY).toBe("chromium");
  });

  // Export and tracking are separate job kinds (maxConcurrent: 1 EACH), so
  // two ensureChromium calls can overlap. playwright-core's `__dirlock` makes
  // a second `install` block silently until the first finishes — the loser
  // would sit there until the 10-min timeout and its `failed` transition
  // could then overwrite the winner's `installed`. One child, fanned out.
  describe("single-flight", () => {
    it("two concurrent callers share one child: one spawn, both resolve, both see every tick", async () => {
      const child = makeChild();
      spawn.mockReturnValue(child);
      const a: Array<{ doneMb: number; totalMb: number }> = [];
      const b: Array<{ doneMb: number; totalMb: number }> = [];

      const runA = ensureChromium({ onProgress: (p) => a.push(p) });
      const runB = ensureChromium({ onProgress: (p) => b.push(p) });
      await flush();
      expect(spawn).toHaveBeenCalledTimes(1);

      child.stdout.write(`|${bar(0)}|   0% of 165.1 MiB\n`);
      child.stdout.write(`|${bar(5)}|  50% of 165.1 MiB\n`);
      child.stdout.write(`|${bar(10)}| 100% of 165.1 MiB\n`);
      await flush();
      layDownChromium();
      child.emit("close", 0, null);
      await Promise.all([runA, runB]);

      const expected = [
        { doneMb: 0, totalMb: 173 },
        { doneMb: 87, totalMb: 173 },
        { doneMb: 173, totalMb: 173 },
      ];
      expect(a).toEqual(expected);
      expect(b).toEqual(expected);
      expect(spawn).toHaveBeenCalledTimes(1);
      // One install → one set of transitions, one `installed`.
      expect(transitions.filter((t) => t.runtimeStatus === "installed")).toHaveLength(1);
    });

    it("a caller that joins mid-download is handed the last tick at once, then the rest", async () => {
      const child = makeChild();
      spawn.mockReturnValue(child);
      const a: Array<{ doneMb: number; totalMb: number }> = [];
      const b: Array<{ doneMb: number; totalMb: number }> = [];

      const runA = ensureChromium({ onProgress: (p) => a.push(p) });
      await flush();
      child.stdout.write(`|${bar(5)}|  50% of 165.1 MiB\n`);
      await flush();
      expect(a).toEqual([{ doneMb: 87, totalMb: 173 }]);

      const runB = ensureChromium({ onProgress: (p) => b.push(p) });
      // Replayed synchronously — the joiner's job shows "87/173 MB", not a
      // blank bar until the next 10% step lands.
      expect(b).toEqual([{ doneMb: 87, totalMb: 173 }]);
      expect(spawn).toHaveBeenCalledTimes(1);

      child.stdout.write(`|${bar(10)}| 100% of 165.1 MiB\n`);
      await flush();
      layDownChromium();
      child.emit("close", 0, null);
      await Promise.all([runA, runB]);
      expect(b).toEqual([
        { doneMb: 87, totalMb: 173 },
        { doneMb: 173, totalMb: 173 },
      ]);
    });

    it("a joiner cancelling leaves the owner's download running; only the joiner rejects", async () => {
      const child = makeChild();
      spawn.mockReturnValue(child);
      const ac = new AbortController();

      const runA = ensureChromium();
      await flush();
      const runB = ensureChromium({ signal: ac.signal });
      ac.abort();
      await expect(runB).rejects.toThrow(/chromium install cancelled/);
      expect(child.kill).not.toHaveBeenCalled();

      layDownChromium();
      child.emit("close", 0, null);
      await expect(runA).resolves.toBeUndefined();
      expect(transitions.at(-1)).toMatchObject({ runtimeStatus: "installed" });
    });

    /**
     * Race: ownership used to be asymmetric: the caller that STARTED
     * the flight killed the child on its own cancel and failed every waiter,
     * so a Settings download that merely joined an export's flight was told
     * "chromium install cancelled" because someone else's job stopped. There
     * is no owner now — the last participant out kills the child.
     */
    it("the STARTER cancelling detaches only itself; a joiner inherits the download", async () => {
      const child = makeChild();
      spawn.mockReturnValue(child);
      const ac = new AbortController();

      const runA = ensureChromium({ signal: ac.signal });
      await flush();
      const b: Array<{ doneMb: number; totalMb: number }> = [];
      const runB = ensureChromium({ onProgress: (p) => b.push(p) });
      ac.abort();

      await expect(runA).rejects.toThrow(/cancelled/);
      expect(child.kill).not.toHaveBeenCalled();

      // …and B still gets the ticks and the completion.
      child.stdout.write(`|${bar(10)}| 100% of 165.1 MiB\n`);
      await flush();
      layDownChromium();
      child.emit("close", 0, null);
      await expect(runB).resolves.toBeUndefined();
      expect(b.at(-1)).toEqual({ doneMb: 173, totalMb: 173 });
      expect(transitions.at(-1)).toMatchObject({ runtimeStatus: "installed" });
    });

    it("kills the child once the LAST participant leaves, not the first", async () => {
      const child = makeChild();
      spawn.mockReturnValue(child);
      const acA = new AbortController();
      const acB = new AbortController();

      const runA = ensureChromium({ signal: acA.signal });
      await flush();
      const runB = ensureChromium({ signal: acB.signal });

      acA.abort();
      await expect(runA).rejects.toThrow(/cancelled/);
      expect(child.kill).not.toHaveBeenCalled();

      acB.abort();
      await expect(runB).rejects.toThrow(/cancelled/);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("after a failed install the next call starts a fresh child", async () => {
      const first = makeChild();
      spawn.mockReturnValueOnce(first);
      const runA = ensureChromium();
      await flush();
      first.emit("close", 1, null);
      await expect(runA).rejects.toThrow(/exited 1/);

      const second = makeChild();
      spawn.mockReturnValueOnce(second);
      const runB = ensureChromium();
      await flush();
      expect(spawn).toHaveBeenCalledTimes(2);
      layDownChromium();
      second.emit("close", 0, null);
      await expect(runB).resolves.toBeUndefined();
    });
  });
});
