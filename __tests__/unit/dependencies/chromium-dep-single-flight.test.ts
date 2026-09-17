import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb } from "../../helpers/test-db";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

/**
 * The Settings Download / Re-download button POSTs retry-dep, which calls
 * `DependencyManager.retryDep("libi-export", "chromium")`. Before a
 * re-review, it ran its own `playwright install … --force` through
 * `execFileAsync` — a SECOND spawn site next to `ensureChromium`, outside its
 * single-flight. A click during an export-driven download queued behind
 * playwright's `__dirlock`, then force-removed the revision the finished
 * export was about to launch. And `getStatuses` answered from disk only, so
 * the chip showed `pending + Download` throughout — inviting exactly that
 * click.
 *
 * Now the chromium dep has ONE install path: `retryDep` / `ensureDep` /
 * Category A's custom-dep loop all reach `ensureChromium`, which joins the
 * flight already running instead of spawning, and `getStatuses` reports the
 * flight as `installing` with its bytes.
 */

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
// One child_process mock, registered under BOTH specifiers: dependency-manager
// imports "child_process" (its `which` probes — nothing is on PATH here) and
// ensure-chromium imports "node:child_process" (the ONE install spawn site,
// plus its node version probe). Whether vitest keys the two under one module
// id depends on what the vite server resolved first in this worker — a batch
// of other files can flip it — so each specifier gets the complete factory,
// and no ordering can hand ensure-chromium a real `spawn` (a 173 MB download).
const cp = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("child_process", async (orig) => ({
  ...(await orig<typeof import("child_process")>()),
  execSync: vi.fn(() => {
    throw new Error("not on PATH");
  }),
  execFile: cp.execFile,
  spawn: cp.spawn,
}));
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  execSync: vi.fn(() => {
    throw new Error("not on PATH");
  }),
  execFile: cp.execFile,
  spawn: cp.spawn,
}));
const pw = vi.hoisted(() => ({ executablePath: "" }));
vi.mock("playwright-core", () => ({
  chromium: { executablePath: () => pw.executablePath },
}));
vi.mock("@/lib/runtime/node-runtime", () => ({
  resolveNodeCommand: () => "/fake/bin/node",
}));

import { getDb } from "@/lib/db/client";
import { seedDatabase } from "@/lib/db/init";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import { writeDepTransition } from "@/mcp/registry/dep-transition";
import { playwrightChromiumRevision } from "@/lib/playwright/paths";
import {
  ensureChromium,
  _resetSpawnedNodeVersionCache,
  _resetChromiumInstallState,
} from "@/lib/export/ensure-chromium";
import {
  markDepInstalling,
  clearDepInstalling,
  _resetDepInFlight,
} from "@/mcp/registry/dep-in-flight";

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

const bar = (row: number) => "■".repeat(row * 8) + " ".repeat((10 - row) * 8);
const flush = () => new Promise<void>((r) => setImmediate(r));
const TOTAL = Math.round(165.1 * 1024 * 1024);
const HALF = Math.round(TOTAL / 2);

function chromiumRow(): Record<string, unknown> | undefined {
  const db = vi.mocked(getDb)();
  const row = db.select().from(mcpServers).where(eq(mcpServers.id, "libi-export")).all()[0];
  const list = JSON.parse(row.dependencyStatus ?? "[]") as Array<Record<string, unknown>>;
  return list.find((e) => e.binary === "chromium");
}

describe("libi-export chromium dep — one install path", () => {
  let tmp: string;
  let cache: string;
  let prevBrowsersPath: string | undefined;
  let revision: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-chromium-dep-"));
    cache = path.join(tmp, "ms-playwright");
    fs.mkdirSync(cache, { recursive: true });
    prevBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
    pw.executablePath = path.join(cache, "chromium-x", "chrome");
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    seedDatabase(db as never);
    cp.spawn.mockReset();
    cp.execFile.mockReset().mockImplementation((...args: unknown[]) => {
      const cb = args.at(-1);
      if (typeof cb === "function") cb(null, "v24.18.0\n", "");
    });
    _resetSpawnedNodeVersionCache();
    // Both are module-level by design — a leak here would steer the next test.
    _resetChromiumInstallState();
    _resetDepInFlight();
    revision = playwrightChromiumRevision()!;
    expect(revision).toMatch(/^\d+$/);
  });

  afterEach(() => {
    if (prevBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = prevBrowsersPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function layDownChromium(): void {
    const dir = path.join(cache, `chromium-${revision}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "INSTALLATION_COMPLETE"), "");
    pw.executablePath = path.join(dir, "chrome");
    fs.writeFileSync(pw.executablePath, "");
  }

  it("ensureDep during an export-driven download joins the flight: one spawn, both resolve, status follows the flight", async () => {
    const child = makeChild();
    cp.spawn.mockReturnValue(child);
    const manager = new DependencyManager();

    // Before anything: on demand, nothing on disk.
    expect(await manager.getStatuses("libi-export")).toEqual([
      expect.objectContaining({ binary: "chromium", installed: false, runtimeStatus: "pending", manualInstall: true }),
    ]);

    const exportDriven = ensureChromium();
    await flush();
    const tracker = manager.ensureDep("libi-export", "chromium");
    await flush();
    expect(cp.spawn).toHaveBeenCalledTimes(1);

    // Mid-flight, before any tick: installing, no bytes yet.
    expect(await manager.getStatuses("libi-export")).toEqual([
      {
        binary: "chromium",
        installed: false,
        path: null,
        source: null,
        runtimeStatus: "installing",
        manualInstall: true,
      },
    ]);

    child.stdout.write(`|${bar(5)}|  50% of 165.1 MiB\n`);
    await flush();
    // The chip's percentage comes from the flight's own ticks.
    expect(await manager.getStatuses("libi-export")).toEqual([
      {
        binary: "chromium",
        installed: false,
        path: null,
        source: null,
        runtimeStatus: "installing",
        bytesDownloaded: HALF,
        bytesTotal: TOTAL,
        manualInstall: true,
      },
    ]);

    layDownChromium();
    child.emit("close", 0, null);
    await Promise.all([exportDriven, tracker]);

    expect(cp.spawn).toHaveBeenCalledTimes(1);
    expect(await manager.getStatuses("libi-export")).toEqual([
      {
        binary: "chromium",
        installed: true,
        path: pw.executablePath,
        source: "bundled",
        runtimeStatus: "installed",
        manualInstall: true,
      },
    ]);
    expect(chromiumRow()).toMatchObject({ runtimeStatus: "installed", installed: true });
  });

  it("retryDep (what the Download button POSTs) mid-flight does not spawn a second install", async () => {
    const child = makeChild();
    cp.spawn.mockReturnValue(child);
    const manager = new DependencyManager();

    const exportDriven = ensureChromium();
    await flush();
    const clicked = manager.retryDep("libi-export", "chromium");
    await flush();
    expect(cp.spawn).toHaveBeenCalledTimes(1);
    expect(chromiumRow()).toMatchObject({ runtimeStatus: "installing" });

    layDownChromium();
    child.emit("close", 0, null);
    await Promise.all([exportDriven, clicked]);
    expect(cp.spawn).toHaveBeenCalledTimes(1);
    expect(chromiumRow()).toMatchObject({ runtimeStatus: "installed", installed: true });
  });

  /**
   * Race: `runCustomInstaller` derives `force` from a fresh
   * `installer.verify()`, i.e. from what is on disk at THAT instant — which is
   * not the instant the user clicked. A Download clicked while an
   * export-driven install was running is `force: false` and joins it; but if
   * that install finishes in between, the same click re-reads the disk, finds
   * a Chromium, and becomes a forced re-download of what just landed.
   */
  it("a Download accepted before an install completed does not turn into a second forced download", async () => {
    const child = makeChild();
    cp.spawn.mockReturnValue(child);
    const manager = new DependencyManager();

    // The user clicks while an export-driven download is running — this is
    // what the route stamps before it fires retryDep.
    markDepInstalling("libi-export", "chromium");
    const exportDriven = ensureChromium();
    await flush();
    expect(cp.spawn).toHaveBeenCalledTimes(1);

    // …and it completes before the click's own `verify()` runs. (The wait is
    // only so the completion lands in a LATER millisecond than the click — a
    // real download takes minutes.)
    await new Promise((r) => setTimeout(r, 5));
    layDownChromium();
    child.emit("close", 0, null);
    await exportDriven;

    // Now the click lands. verify() says installed → force → and without the
    // requestedAt check this spawns a second 173 MB `--force` download.
    const clicked = manager.retryDep("libi-export", "chromium");
    await flush();
    // Asserted BEFORE the await: a regression re-spawns and, because the fake
    // child has already closed, would hang instead of failing.
    expect(cp.spawn).toHaveBeenCalledTimes(1);
    await clicked;
    expect(cp.spawn).toHaveBeenCalledTimes(1);
    expect(chromiumRow()).toMatchObject({ runtimeStatus: "installed", installed: true });
    clearDepInstalling("libi-export", "chromium");
  });

  it("a Re-download requested AFTER the last install still forces", async () => {
    const first = makeChild();
    cp.spawn.mockReturnValueOnce(first);
    const manager = new DependencyManager();
    const download = manager.retryDep("libi-export", "chromium");
    await flush();
    layDownChromium();
    first.emit("close", 0, null);
    await download;

    // Stamped after the completion — a genuine "replace what I have".
    await new Promise((r) => setTimeout(r, 5));
    markDepInstalling("libi-export", "chromium");
    const second = makeChild();
    cp.spawn.mockReturnValueOnce(second);
    const redownload = manager.retryDep("libi-export", "chromium");
    await flush();
    expect(cp.spawn).toHaveBeenCalledTimes(2);
    expect((cp.spawn.mock.calls[1]![1] as string[])).toContain("--force");
    second.emit("close", 0, null);
    await redownload;
    clearDepInstalling("libi-export", "chromium");
  });

  /**
   * Race: the route answers `{ accepted: true }` immediately and runs
   * retryDep in the background; until the install path announces itself the
   * chip's poll still said `pending`, whose branch renders the Download button
   * — so a second click could start a second download.
   */
  it("reports an accepted-but-not-yet-started install as installing, so the chip shows no button", async () => {
    const manager = new DependencyManager();
    expect(await manager.getStatuses("libi-export")).toEqual([
      expect.objectContaining({ runtimeStatus: "pending" }),
    ]);

    markDepInstalling("libi-export", "chromium");
    expect(await manager.getStatuses("libi-export")).toEqual([
      {
        binary: "chromium",
        installed: false,
        path: null,
        source: null,
        runtimeStatus: "installing",
        manualInstall: true,
      },
    ]);

    clearDepInstalling("libi-export", "chromium");
    expect(await manager.getStatuses("libi-export")).toEqual([
      expect.objectContaining({ runtimeStatus: "pending" }),
    ]);
  });

  it("never HIDES a flight's byte progress behind the accepted marker", async () => {
    const child = makeChild();
    cp.spawn.mockReturnValue(child);
    const manager = new DependencyManager();
    markDepInstalling("libi-export", "chromium");
    const run = ensureChromium();
    await flush();
    child.stdout.write(`|${bar(5)}|  50% of 165.1 MiB\n`);
    await flush();

    expect(await manager.getStatuses("libi-export")).toEqual([
      expect.objectContaining({
        runtimeStatus: "installing",
        bytesDownloaded: HALF,
        bytesTotal: TOTAL,
      }),
    ]);

    layDownChromium();
    child.emit("close", 0, null);
    await run;
    clearDepInstalling("libi-export", "chromium");
  });

  it("Download (nothing on disk) spawns without --force; Re-download (installed) spawns with it", async () => {
    const manager = new DependencyManager();

    const first = makeChild();
    cp.spawn.mockReturnValueOnce(first);
    const download = manager.retryDep("libi-export", "chromium");
    await flush();
    expect(cp.spawn).toHaveBeenCalledTimes(1);
    expect(cp.spawn.mock.calls[0]![0]).toBe("/fake/bin/node");
    expect((cp.spawn.mock.calls[0]![1] as string[]).slice(1)).toEqual([
      "install",
      "chromium",
      "--no-shell",
    ]);
    layDownChromium();
    first.emit("close", 0, null);
    await download;
    expect(chromiumRow()).toMatchObject({ runtimeStatus: "installed" });

    // Re-download: `playwright install` returns 0 without touching an existing
    // install unless forced — the only path that passes --force.
    const second = makeChild();
    cp.spawn.mockReturnValueOnce(second);
    const redownload = manager.retryDep("libi-export", "chromium");
    await flush();
    expect(cp.spawn).toHaveBeenCalledTimes(2);
    expect((cp.spawn.mock.calls[1]![1] as string[]).slice(1)).toEqual([
      "install",
      "chromium",
      "--no-shell",
      "--force",
    ]);
    // While the forced replacement runs the chip must not offer a second one.
    expect(await manager.getStatuses("libi-export")).toEqual([
      expect.objectContaining({ runtimeStatus: "installing", installed: false }),
    ]);
    second.emit("close", 0, null);
    await redownload;
    expect(chromiumRow()).toMatchObject({ runtimeStatus: "installed" });
  });

  it("a failed flight surfaces as `failed` with its error, and the next Retry spawns afresh", async () => {
    const manager = new DependencyManager();
    const first = makeChild();
    cp.spawn.mockReturnValueOnce(first);
    const run = ensureChromium();
    await flush();
    first.stderr.write("Error: connect ECONNRESET cdn.playwright.dev\n");
    await flush();
    first.emit("close", 1, null);
    await expect(run).rejects.toThrow(/ECONNRESET/);

    expect(await manager.getStatuses("libi-export")).toEqual([
      {
        binary: "chromium",
        installed: false,
        path: null,
        source: null,
        runtimeStatus: "failed",
        error: expect.stringMatching(/ECONNRESET/),
        manualInstall: true,
      },
    ]);

    const second = makeChild();
    cp.spawn.mockReturnValueOnce(second);
    const retry = manager.retryDep("libi-export", "chromium");
    await flush();
    expect(cp.spawn).toHaveBeenCalledTimes(2);
    layDownChromium();
    second.emit("close", 0, null);
    await retry;
    expect(await manager.getStatuses("libi-export")).toEqual([
      expect.objectContaining({ runtimeStatus: "installed", installed: true }),
    ]);
  });

  it("a persisted `installing` with no flight behind it (a crash mid-download) reads as pending, not installing forever", async () => {
    writeDepTransition("libi-export", "chromium", { runtimeStatus: "installing", bytesDownloaded: 1, bytesTotal: 2 });
    expect(await new DependencyManager().getStatuses("libi-export")).toEqual([
      expect.objectContaining({ runtimeStatus: "pending", installed: false }),
    ]);
    // …and an install that happened elsewhere wins over a stale `failed`.
    writeDepTransition("libi-export", "chromium", { runtimeStatus: "failed", error: "old" });
    layDownChromium();
    expect(await new DependencyManager().getStatuses("libi-export")).toEqual([
      expect.objectContaining({ runtimeStatus: "installed", installed: true }),
    ]);
  });
});
