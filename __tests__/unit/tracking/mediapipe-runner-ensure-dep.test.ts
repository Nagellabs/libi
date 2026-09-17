import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTestDb } from "../../helpers/test-db";

// `mediapipe-vision` is tier-2 since 2026-09-08, so the tracker installs it
// itself before launching Chromium. That install must be idempotent in the
// real sense: the FIRST launch on a machine without the assets downloads
// them once; every launch after that finds them on disk and neither
// downloads nor writes a `runtimeStatus` transition. The original wiring
// went through `retryDep`, which re-downloaded all 33 MB on every tracker
// start and made tracking fail offline even with the assets present.

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

const launch = vi.fn();
vi.mock("playwright-core", () => ({ chromium: { launch } }));

// Chromium itself left Category A: the tracker needs the same
// browser the canvas export does, so `getBrowser` ensures it through the
// export's `ensureChromium` (streamed download, byte progress) rather than
// dying on "Executable doesn't exist" with a hint to run npx by hand.
const ensureChromium = vi.hoisted(() => vi.fn());
vi.mock("@/lib/export/ensure-chromium", async (orig) => ({
  ...(await orig<typeof import("@/lib/export/ensure-chromium")>()),
  ensureChromium,
}));

import { getDb } from "@/lib/db/client";
import { seedDatabase } from "@/lib/db/init";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import { getBrowser } from "@/lib/tracking/mediapipe-runner";

const visionDep = BUNDLED_MCP_SERVERS.find((d) => d.id === "libi-tracking")!
  .dependencies.find((d) => d.binary === "mediapipe-vision")!;

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

describe("mediapipe-runner getBrowser — installs mediapipe-vision on demand, once", () => {
  let tmp: string;
  let prevHome: string | undefined;
  let installMultiFile: ReturnType<typeof vi.spyOn>;
  let writeDepTransition: ReturnType<typeof vi.spyOn>;
  let order: string[];
  let browsers: FakeBrowser[];

  beforeEach(() => {
    order = [];
    browsers = [];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-mp-runner-"));
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = tmp;
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    seedDatabase(db as never);

    // Stand-in for the 33 MB download: lay the seven files + install token
    // down exactly where the real installer would, so the second launch sees
    // an installed dep without any network.
    installMultiFile = vi
      .spyOn(DependencyManager.prototype, "installMultiFile")
      .mockImplementation(async (dep) => {
        order.push("install");
        const dir = path.join(tmp, "models", dep.binary);
        for (const f of dep.files!) {
          const target = path.join(dir, f.relPath);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, `fake ${f.relPath}`);
        }
        fs.writeFileSync(path.join(dir, ".install-token"), dep.pinnedInstallToken!);
      });
    writeDepTransition = vi.spyOn(
      DependencyManager.prototype as unknown as { writeDepTransition: () => void },
      "writeDepTransition",
    );
    launch.mockReset();
    launch.mockImplementation(async () => {
      order.push("launch");
      return browsers.shift();
    });
    ensureChromium.mockReset();
    ensureChromium.mockImplementation(async () => {
      order.push("chromium");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("first launch with assets missing installs once; the next launch with assets present installs nothing and writes no transition", async () => {
    expect(visionDep.pinnedInstallToken).toBeTruthy();
    const first = makeFakeBrowser();
    browsers.push(first);

    await getBrowser();

    expect(installMultiFile).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
    // The assets are served to the page by the launched browser, so the
    // install has to complete before Chromium comes up — and Chromium has to
    // be on disk before it is launched.
    expect(order).toEqual(["install", "chromium", "launch"]);
    // The install path is what the Settings chips poll: installing → installed.
    expect(writeDepTransition.mock.calls.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tmp, "models", "mediapipe-vision", ".install-token"))).toBe(true);

    // Chromium goes away (tracker finished, crashed, whatever) → the cached
    // promise is dropped and the next tracker run launches again.
    first.disconnect();
    installMultiFile.mockClear();
    writeDepTransition.mockClear();
    const second = makeFakeBrowser();
    browsers.push(second);

    await getBrowser();

    expect(launch).toHaveBeenCalledTimes(2);
    expect(installMultiFile).not.toHaveBeenCalled();
    expect(writeDepTransition).not.toHaveBeenCalled();
    // Drop the module-level single-flight cache so the next test launches.
    second.disconnect();
  });

  it("threads a download-progress sink into ensureChromium, and a cancel handle owned by the flight", async () => {
    const browser = makeFakeBrowser();
    browsers.push(browser);
    const onDownloadProgress = vi.fn();
    const shouldCancel = () => false;
    let passedShouldCancel: (() => boolean) | undefined;
    ensureChromium.mockImplementation(
      async (opts: {
        onProgress?: (p: { doneMb: number; totalMb: number }) => void;
        shouldCancel?: () => boolean;
      }) => {
        order.push("chromium");
        passedShouldCancel = opts.shouldCancel;
        // Asked while the caller is still attached: nobody has cancelled.
        expect(opts.shouldCancel?.()).toBe(false);
        opts.onProgress?.({ doneMb: 83, totalMb: 165 });
      },
    );

    await getBrowser({ onDownloadProgress, shouldCancel });

    expect(ensureChromium).toHaveBeenCalledTimes(1);
    // NOT the caller's own handle: the flight is shared, so cancelling
    // it is "every participant has left", not "the caller that happened to
    // start it said stop". Each participant's own `shouldCancel` is polled
    // where it can detach only itself.
    expect(passedShouldCancel).toBeTypeOf("function");
    expect(passedShouldCancel).not.toBe(shouldCancel);
    // The launch resolved, so the only participant has detached — which is
    // exactly what the download would have been cancelled on.
    expect(passedShouldCancel!()).toBe(true);
    expect(onDownloadProgress).toHaveBeenCalledWith({ doneMb: 83, totalMb: 165 });
    expect(order).toEqual(["install", "chromium", "launch"]);
    // Drop the module-level single-flight cache — without this the NEXT test
    // silently gets this browser back and exercises nothing.
    browser.disconnect();
  });

  /**
   * The dependency phase reports on a completely different cadence from
   * the tracking it precedes: the model fetch emits nothing and Playwright
   * emits one line per 10 %, so on a slow link the tracking runner's 60 s
   * no-progress watchdog killed the job and called it a tracking failure. The
   * phase is announced so the runner can suspend the watchdog for exactly it.
   */
  it("brackets BOTH installs with onDependencyPhase, and closes it before launching", async () => {
    const browser = makeFakeBrowser();
    browsers.push(browser);
    const phases: boolean[] = [];
    const onDependencyPhase = (active: boolean) => {
      phases.push(active);
      order.push(active ? "phase:on" : "phase:off");
    };

    await getBrowser({ onDependencyPhase });

    expect(phases).toEqual([true, false]);
    // Open before the model install, closed after Chromium is on disk and
    // BEFORE the browser launch — the launch is the runner's own work again.
    expect(order).toEqual(["phase:on", "install", "chromium", "phase:off", "launch"]);
    // Drop the module-level single-flight cache for the next test.
    browser.disconnect();
  });

  it("closes the dependency phase even when the install throws, and does not cache the failure", async () => {
    const phases: boolean[] = [];
    ensureChromium.mockImplementationOnce(async () => {
      throw new Error("chromium install cancelled");
    });

    await expect(
      getBrowser({ onDependencyPhase: (active) => phases.push(active) }),
    ).rejects.toThrow(/chromium install cancelled/);

    // A leaked `true` would leave the watchdog suspended for the rest of the
    // job — the failure mode the pause is supposed to prevent, inverted.
    expect(phases).toEqual([true, false]);

    // …and the failed flight must not be the cached one. It used to be: the
    // rejected promise stayed in `browserPromise`, so every later tracker
    // start in the process re-threw the same cancel without retrying.
    const browser = makeFakeBrowser();
    browsers.push(browser);
    ensureChromium.mockImplementation(async () => {
      order.push("chromium");
    });
    await expect(getBrowser()).resolves.toBe(browser);
    browser.disconnect();
  });
});
