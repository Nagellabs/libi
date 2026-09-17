import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTestDb } from "../../helpers/test-db";

/**
 * `getBrowser`'s single flight used to be a bare `Promise<Browser>`:
 * `if (browserPromise) return browserPromise`. A second caller got the first
 * caller's browser and NONE of its callbacks — no `onDependencyPhase`, no
 * `onDownloadProgress`, no say in cancellation.
 *
 * That is the same defect fixed for the FIRST caller, one layer down. A
 * tracker that joins an in-flight 173 MB Chromium fetch is told nothing, so it
 * never pauses its 60 s no-progress watchdog, and the watchdog kills it
 * mid-download and reports a tracking failure to the user. `ensureChromium`
 * was given participant semantics for exactly this; this file pins the
 * same treatment here.
 *
 * Pre-existing — not introduced by this branch.
 */

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

const launch = vi.fn();
vi.mock("playwright-core", () => ({ chromium: { launch } }));

const ensureChromium = vi.hoisted(() => vi.fn());
vi.mock("@/lib/export/ensure-chromium", async (orig) => ({
  ...(await orig<typeof import("@/lib/export/ensure-chromium")>()),
  ensureChromium,
}));

import { getDb } from "@/lib/db/client";
import { seedDatabase } from "@/lib/db/init";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import { getBrowser } from "@/lib/tracking/mediapipe-runner";

type FakeBrowser = { on: (ev: string, cb: () => void) => void; disconnect: () => void };

function makeFakeBrowser(): FakeBrowser {
  let onDisconnected: (() => void) | null = null;
  return {
    on: (ev, cb) => {
      if (ev === "disconnected") onDisconnected = cb;
    },
    disconnect: () => onDisconnected?.(),
  };
}

interface ChromiumOpts {
  onProgress?: (p: { doneMb: number; totalMb: number }) => void;
  shouldCancel?: () => boolean;
}

describe("mediapipe-runner getBrowser — a joiner is a participant, not a free rider", () => {
  let tmp: string;
  let prevHome: string | undefined;
  let browser: FakeBrowser;
  /** Held open so both callers are inside the dependency phase at once. */
  let releaseInstall: () => void;
  let chromiumOpts: ChromiumOpts | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-mp-join-"));
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = tmp;
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    seedDatabase(db as never);

    vi.spyOn(DependencyManager.prototype, "installMultiFile").mockImplementation(
      async (dep) => {
        const dir = path.join(tmp, "models", dep.binary);
        for (const f of dep.files!) {
          const target = path.join(dir, f.relPath);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, `fake ${f.relPath}`);
        }
        fs.writeFileSync(path.join(dir, ".install-token"), dep.pinnedInstallToken!);
      },
    );

    browser = makeFakeBrowser();
    launch.mockReset();
    launch.mockImplementation(async () => browser);

    chromiumOpts = undefined;
    const gate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    ensureChromium.mockReset();
    ensureChromium.mockImplementation(async (opts: ChromiumOpts) => {
      chromiumOpts = opts;
      await gate;
    });
  });

  afterEach(() => {
    // Drop the module-level flight so the next test starts clean.
    browser.disconnect();
    vi.restoreAllMocks();
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Wait until the flight is parked inside `ensureChromium`. */
  async function reachInstall(): Promise<void> {
    await vi.waitFor(() => expect(chromiumOpts).toBeDefined());
  }

  it("tells a caller that JOINS mid-install that a dependency phase is running", async () => {
    const first: boolean[] = [];
    const firstProgress = vi.fn();
    const pFirst = getBrowser({
      onDependencyPhase: (a) => first.push(a),
      onDownloadProgress: firstProgress,
    });
    await reachInstall();
    expect(first).toEqual([true]);

    // The second tracker arrives while the 173 MB download is running.
    const second: boolean[] = [];
    const secondProgress = vi.fn();
    const pSecond = getBrowser({
      onDependencyPhase: (a) => second.push(a),
      onDownloadProgress: secondProgress,
    });

    // THE defect: this was `[]`, so the joiner's 60 s watchdog stayed armed
    // through a download that reports one line per 10 %.
    expect(second).toEqual([true]);

    // Ticks fan out to BOTH sinks from here on.
    chromiumOpts!.onProgress!({ doneMb: 87, totalMb: 173 });
    expect(firstProgress).toHaveBeenCalledWith({ doneMb: 87, totalMb: 173 });
    expect(secondProgress).toHaveBeenCalledWith({ doneMb: 87, totalMb: 173 });

    // A LATE joiner gets the last tick replayed rather than a blank bar until
    // the next 10 % step.
    const thirdProgress = vi.fn();
    const third: boolean[] = [];
    const pThird = getBrowser({
      onDependencyPhase: (a) => third.push(a),
      onDownloadProgress: thirdProgress,
    });
    expect(third).toEqual([true]);
    expect(thirdProgress).toHaveBeenCalledWith({ doneMb: 87, totalMb: 173 });

    releaseInstall();
    const browsers = await Promise.all([pFirst, pSecond, pThird]);

    // One install, one launch, one browser — the single flight still holds.
    expect(ensureChromium).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(browsers[0]).toBe(browsers[1]);
    expect(browsers[1]).toBe(browsers[2]);

    // …and every participant's phase is closed, so every watchdog re-arms.
    expect(first).toEqual([true, false]);
    expect(second).toEqual([true, false]);
    expect(third).toEqual([true, false]);
  });

  it("does not replay stale progress to a caller that joins a SETTLED flight", async () => {
    // `browserFlight` is deliberately not cleared on success — it
    // doubles as the browser cache — so `lastProgress` outlives the install
    // that produced it. Every later tracking job in the process then had
    // "173 / 173 MB" pushed into `ctx.reportProgress` before its frame counter
    // started: a download that is not happening, reported outside any
    // dependency phase. `ensureChromium` cannot have this bug because it nulls
    // its `inFlight` in a `finally`.
    const pFirst = getBrowser({});
    await reachInstall();
    chromiumOpts!.onProgress!({ doneMb: 173, totalMb: 173 });
    releaseInstall();
    await expect(pFirst).resolves.toBe(browser);

    const lateProgress = vi.fn();
    const latePhase: boolean[] = [];
    await expect(
      getBrowser({ onDownloadProgress: lateProgress, onDependencyPhase: (a) => latePhase.push(a) }),
    ).resolves.toBe(browser);
    expect(lateProgress).not.toHaveBeenCalled();
    expect(latePhase).toEqual([]);
  });

  it("one participant's cancel detaches only that participant", async () => {
    let firstCancelled = false;
    const first: boolean[] = [];
    const pFirst = getBrowser({
      onDependencyPhase: (a) => first.push(a),
      shouldCancel: () => firstCancelled,
    });
    await reachInstall();

    const second: boolean[] = [];
    const pSecond = getBrowser({ onDependencyPhase: (a) => second.push(a) });
    expect(second).toEqual([true]);

    firstCancelled = true;
    await expect(pFirst).rejects.toThrow(/cancelled/i);
    // Its own watchdog re-arms on the way out — `emitDependencyPhase(false)`
    // will never reach a detached participant.
    expect(first).toEqual([true, false]);

    // The download carries on for whoever is left. Under the old code the
    // starter's `shouldCancel` went straight to `ensureChromium` and killed
    // the shared install, failing the second caller for someone else's reason.
    expect(chromiumOpts!.shouldCancel!()).toBe(false);
    expect(second).toEqual([true]);

    releaseInstall();
    await expect(pSecond).resolves.toBe(browser);
    expect(second).toEqual([true, false]);
    expect(launch).toHaveBeenCalledTimes(1);
  }, 15_000);
});
