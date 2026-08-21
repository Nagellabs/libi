import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LoadedRuntime } from "@/electron/runtime-loader";

/**
 * `electron/shell-updater.ts` — the LIBI_SHELL_UPDATE_FEED override.
 *
 * `forceDevUpdateConfig: true` bypasses the packaged app's app-update.yml,
 * and `autoInstallOnAppQuit: true` (set unconditionally a few lines below the
 * override) means whoever controls the feed URL controls what code runs at
 * the user's next quit. Anyone who can set a persistent env var for the GUI
 * session must NOT be able to redirect a packaged build's updates, and even
 * in dev the override must refuse a plain http:// feed.
 */

interface FakeApp {
  isPackaged: boolean;
  getVersion(): string;
  getPath(name: string): string;
  isInApplicationsFolder(): boolean;
}

let fakeApp: FakeApp;
/** Stands in for /Applications — a directory the probe can really write to. */
let writableDir: string;

interface FakeAutoUpdater {
  forceDevUpdateConfig: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: unknown;
  setFeedURL: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
}

let fakeAutoUpdater: FakeAutoUpdater;

vi.mock("electron", () => ({
  get app() {
    return fakeApp;
  },
}));

vi.mock("electron-updater", () => ({
  get autoUpdater() {
    return fakeAutoUpdater;
  },
}));

function makeRuntime(): LoadedRuntime {
  return {
    api: {
      registerShellUpdater: vi.fn(),
    },
  } as unknown as LoadedRuntime;
}

async function loadShellUpdater() {
  vi.resetModules();
  return import("@/electron/shell-updater");
}

beforeEach(() => {
  fakeApp = {
    isPackaged: false,
    getVersion: () => "1.0.0",
    // A writable temp dir by default, so the write probe says "can update".
    // The blocked tests below point this at somewhere that does not exist.
    getPath: () => path.join(writableDir, "Libi.app", "Contents", "MacOS", "Libi"),
    isInApplicationsFolder: () => true,
  };
  fakeAutoUpdater = {
    forceDevUpdateConfig: false,
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: null,
    setFeedURL: vi.fn(),
    on: vi.fn(),
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
  };
  // initShellUpdater schedules a real first check via setTimeout; keep it
  // from ever firing during the test.
  writableDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-shell-updater-"));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.LIBI_SHELL_UPDATE_FEED;
  fs.rmSync(writableDir, { recursive: true, force: true });
});

describe("LIBI_SHELL_UPDATE_FEED", () => {
  it("is ignored in a packaged build", async () => {
    fakeApp.isPackaged = true;
    process.env.LIBI_SHELL_UPDATE_FEED = "https://example.com/feed.yml";
    const { initShellUpdater } = await loadShellUpdater();

    initShellUpdater(makeRuntime(), vi.fn());

    expect(fakeAutoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(fakeAutoUpdater.forceDevUpdateConfig).toBe(false);
  });

  it("is ignored for a non-https URL", async () => {
    fakeApp.isPackaged = false;
    process.env.LIBI_SHELL_UPDATE_FEED = "http://example.com/feed.yml";
    const { initShellUpdater } = await loadShellUpdater();

    initShellUpdater(makeRuntime(), vi.fn());

    expect(fakeAutoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(fakeAutoUpdater.forceDevUpdateConfig).toBe(false);
  });

  it("is honoured for an https URL in development", async () => {
    fakeApp.isPackaged = false;
    process.env.LIBI_SHELL_UPDATE_FEED = "https://example.com/feed.yml";
    const { initShellUpdater } = await loadShellUpdater();

    initShellUpdater(makeRuntime(), vi.fn());

    expect(fakeAutoUpdater.setFeedURL).toHaveBeenCalledTimes(1);
    expect(fakeAutoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://example.com/feed.yml",
    });
    expect(fakeAutoUpdater.forceDevUpdateConfig).toBe(true);
  });
});

/**
 * The auto-download contract: downloads start themselves, a verified
 * download PARKS at "ready", and only an explicit restart — `restart()`, or
 * an old runtime's `download()` click landing on a ready download — calls
 * `quitAndInstall`. A regression here either re-introduces the click-to-
 * download flow or, worse, restarts the app under the user with no consent.
 */
describe("auto-download behaviour", () => {
  interface Bridge {
    getStatus(): { phase: string; autoDownload?: boolean; error: string | null };
    download(): void;
    restart?(): void;
  }

  /** Boot the updater (dev + https override so init doesn't skip) and hand
   *  back the registered bridge plus a way to fire autoUpdater events. */
  async function boot(): Promise<{
    bridge: Bridge;
    emit: (event: string, payload?: unknown) => void;
  }> {
    fakeApp.isPackaged = false;
    process.env.LIBI_SHELL_UPDATE_FEED = "https://example.com/feed.yml";
    const { initShellUpdater } = await loadShellUpdater();
    const runtime = makeRuntime();
    initShellUpdater(runtime, vi.fn());
    const register = runtime.api.registerShellUpdater as ReturnType<typeof vi.fn>;
    const bridge = register.mock.calls[0][0] as Bridge;
    const emit = (event: string, payload?: unknown) => {
      for (const [name, handler] of fakeAutoUpdater.on.mock.calls) {
        if (name === event) (handler as (p: unknown) => void)(payload);
      }
    };
    return { bridge, emit };
  }

  it("turns autoDownload on and applies on quit as the fallback", async () => {
    await boot();
    expect(fakeAutoUpdater.autoDownload).toBe(true);
    expect(fakeAutoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it("advertises autoDownload in its status so the UI can tell shell generations apart", async () => {
    const { bridge } = await boot();
    expect(bridge.getStatus().autoDownload).toBe(true);
  });

  it("parks at ready after a download instead of restarting", async () => {
    const { bridge, emit } = await boot();
    emit("update-available", { version: "2.0.0" });
    emit("update-downloaded", { version: "2.0.0" });

    expect(bridge.getStatus().phase).toBe("ready");
    vi.advanceTimersByTime(60_000);
    expect(fakeAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("restart() on a ready download quits and installs after the UI beat", async () => {
    const { bridge, emit } = await boot();
    emit("update-downloaded", { version: "2.0.0" });

    bridge.restart!();
    expect(fakeAutoUpdater.quitAndInstall).not.toHaveBeenCalled(); // the beat
    vi.advanceTimersByTime(2_500);
    expect(fakeAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("restart() during the download installs when the download lands", async () => {
    const { bridge, emit } = await boot();
    emit("download-progress", { percent: 40 });

    bridge.restart!();
    vi.advanceTimersByTime(60_000);
    expect(fakeAutoUpdater.quitAndInstall).not.toHaveBeenCalled();

    emit("update-downloaded", { version: "2.0.0" });
    vi.advanceTimersByTime(2_500);
    expect(fakeAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("download() on a ready download restarts — the old runtime's Install click", async () => {
    const { bridge, emit } = await boot();
    emit("update-downloaded", { version: "2.0.0" });

    bridge.download();
    vi.advanceTimersByTime(2_500);
    expect(fakeAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(fakeAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("download() while a download runs is a no-op", async () => {
    const { bridge, emit } = await boot();
    emit("download-progress", { percent: 10 });

    bridge.download();
    expect(fakeAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(fakeAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("a download error clears restart consent — no surprise install later", async () => {
    const { bridge, emit } = await boot();
    emit("download-progress", { percent: 40 });
    bridge.restart!();
    emit("error", new Error("network gone"));

    expect(bridge.getStatus().phase).toBe("error");
    // A later successful download must NOT inherit the pre-error consent.
    emit("update-downloaded", { version: "2.0.0" });
    vi.advanceTimersByTime(60_000);
    expect(fakeAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});

/**
 * The blocked contract (A0). During the 0.1.2 QA run the shell downloaded
 * 481 MB and only THEN discovered it was running from a read-only
 * AppTranslocation path. The user saw one log line, and a "Try again" button
 * that re-downloaded 481 MB to fail identically, forever.
 *
 * These pin the two halves of the fix: the probe runs BEFORE the check, and
 * a blocked install downloads nothing while saying loudly that it can't.
 */
describe("an install that cannot replace its own bundle", () => {
  // These assert macOS behaviour, so they must ASK for macOS rather than
  // inherit whatever the host happens to be. `initShellUpdater` passes
  // `process.platform` into the probe, and on Linux the probe deliberately
  // never blocks (apt/dnf installs are updated by the package manager, so a
  // block there would be a pure false positive) — which made every one of
  // these pass on a Mac and fail on CI's ubuntu runner.
  //
  // Worth being blunt about: an environment-dependent test is what kept this
  // repo's CI red for five releases. A test that only holds on the machine
  // that wrote it is not a test.
  let realPlatform: PropertyDescriptor | undefined;
  beforeEach(() => {
    realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
  });
  afterEach(() => {
    if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
  });

  interface Bridge {
    getStatus(): {
      phase: string;
      latestVersion: string | null;
      blockedReason?: string | null;
      blockedPath?: string | null;
      error: string | null;
    };
    checkNow(): Promise<void>;
    download(): void;
    restart?(): void;
  }

  async function boot(): Promise<{
    bridge: Bridge;
    emit: (event: string, payload?: unknown) => void;
  }> {
    fakeApp.isPackaged = false;
    process.env.LIBI_SHELL_UPDATE_FEED = "https://example.com/feed.yml";
    const { initShellUpdater } = await loadShellUpdater();
    const runtime = makeRuntime();
    initShellUpdater(runtime, vi.fn());
    const register = runtime.api.registerShellUpdater as ReturnType<typeof vi.fn>;
    const bridge = register.mock.calls[0][0] as Bridge;
    const emit = (event: string, payload?: unknown) => {
      for (const [name, handler] of fakeAutoUpdater.on.mock.calls) {
        if (name === event) (handler as (p: unknown) => void)(payload);
      }
    };
    return { bridge, emit };
  }

  /** Point the app at a directory that does not exist, so the probe fails. */
  function makeUnwritable(kind: "translocated" | "plain") {
    const base =
      kind === "translocated"
        ? "/private/var/folders/gh/x8k/T/AppTranslocation/A1B2/d"
        : path.join(writableDir, "gone");
    fakeApp.getPath = () => path.join(base, "Libi.app", "Contents", "MacOS", "Libi");
    fakeApp.isInApplicationsFolder = () => false;
  }

  it("turns autoDownload OFF before the check, so finding an update can't start one", async () => {
    const { bridge } = await boot();
    makeUnwritable("translocated");

    await bridge.checkNow();

    expect(fakeAutoUpdater.autoDownload).toBe(false);
    expect(fakeAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("reports blocked — not error — with the reason and the path as evidence", async () => {
    const { bridge, emit } = await boot();
    makeUnwritable("translocated");

    await bridge.checkNow();
    emit("update-available", { version: "0.1.2" });

    const status = bridge.getStatus();
    // `error` is documented as silent in the UI; this must be loud.
    expect(status.phase).toBe("blocked");
    expect(status.latestVersion).toBe("0.1.2");
    expect(status.blockedReason).toBe("translocated");
    expect(status.blockedPath).toContain("AppTranslocation");
  });

  it("never downloads while blocked, however the click arrives", async () => {
    const { bridge, emit } = await boot();
    makeUnwritable("translocated");
    await bridge.checkNow();
    emit("update-available", { version: "0.1.2" });

    // An old runtime's UI knows nothing about `blocked` and sends this.
    bridge.download();
    bridge.restart!();
    vi.advanceTimersByTime(60_000);

    expect(fakeAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(fakeAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(bridge.getStatus().phase).toBe("blocked");
  });

  // The condition is environmental: the user fixes it in Finder and the app
  // cannot observe that. So nothing about the verdict may be cached.
  it("clears the block on the next check once the location is writable", async () => {
    const { bridge, emit } = await boot();
    makeUnwritable("translocated");
    await bridge.checkNow();
    emit("update-available", { version: "0.1.2" });
    expect(bridge.getStatus().phase).toBe("blocked");

    // The user drags Libi into Applications and presses "Check again".
    fakeApp.getPath = () =>
      path.join(writableDir, "Libi.app", "Contents", "MacOS", "Libi");
    fakeApp.isInApplicationsFolder = () => true;
    await bridge.checkNow();
    emit("update-available", { version: "0.1.2" });

    expect(fakeAutoUpdater.autoDownload).toBe(true);
    const status = bridge.getStatus();
    expect(status.phase).toBe("update-available");
    expect(status.blockedReason).toBeNull();
  });

  // A check failure must not overwrite the one update state the user has to
  // act on — that would put them straight back in the original bug.
  it("keeps the blocked verdict when a later check errors", async () => {
    const { bridge, emit } = await boot();
    makeUnwritable("translocated");
    await bridge.checkNow();
    emit("update-available", { version: "0.1.2" });

    emit("error", new Error("network gone"));

    expect(bridge.getStatus().phase).toBe("blocked");
    expect(bridge.getStatus().error).toBe("network gone");
  });

  it("says nothing when there is no update to be blocked from", async () => {
    const { bridge, emit } = await boot();
    makeUnwritable("plain");

    await bridge.checkNow();
    emit("update-not-available");

    const status = bridge.getStatus();
    expect(status.phase).toBe("up-to-date");
    expect(status.blockedReason).toBeNull();
  });

  it("leaves a writable install completely alone", async () => {
    const { bridge, emit } = await boot();

    await bridge.checkNow();
    emit("update-available", { version: "0.1.2" });

    expect(fakeAutoUpdater.autoDownload).toBe(true);
    expect(bridge.getStatus().phase).toBe("update-available");
  });
});

/**
 * A0c — a download that dies mid-stream on a network hiccup.
 *
 * Observed live during the 0.1.2 QA run: `net::ERR_NETWORK_CHANGED` after
 * 2m13s, and the manual retry succeeded in 23s. Our wrapper turned any error
 * into a terminal state and scheduled nothing, and electron-updater's own
 * `retryOnServerError` covers HTTP 5xx and EPIPE, not this. Someone whose
 * sessions are shorter than a 481 MB download would never complete one.
 */
describe("retrying a download that failed mid-stream", () => {
  interface Bridge {
    getStatus(): { phase: string; error: string | null; percent: number | null };
    checkNow(): Promise<void>;
    restart?(): void;
  }

  async function boot(): Promise<{
    bridge: Bridge;
    emit: (event: string, payload?: unknown) => void;
  }> {
    fakeApp.isPackaged = false;
    process.env.LIBI_SHELL_UPDATE_FEED = "https://example.com/feed.yml";
    const { initShellUpdater } = await loadShellUpdater();
    const runtime = makeRuntime();
    initShellUpdater(runtime, vi.fn());
    const register = runtime.api.registerShellUpdater as ReturnType<typeof vi.fn>;
    const bridge = register.mock.calls[0][0] as Bridge;
    const emit = (event: string, payload?: unknown) => {
      for (const [name, handler] of fakeAutoUpdater.on.mock.calls) {
        if (name === event) (handler as (p: unknown) => void)(payload);
      }
    };
    return { bridge, emit };
  }

  it("retries a network-class failure after a backoff", async () => {
    const { emit } = await boot();
    emit("update-available", { version: "0.1.2" });
    emit("download-progress", { percent: 40 });

    emit("error", new Error("net::ERR_NETWORK_CHANGED"));
    expect(fakeAutoUpdater.downloadUpdate).not.toHaveBeenCalled(); // the backoff

    vi.advanceTimersByTime(5_000);
    expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("gives up after two retries instead of looping forever", async () => {
    const { bridge, emit } = await boot();
    emit("update-available", { version: "0.1.2" });
    emit("download-progress", { percent: 40 });

    const fail = () => emit("error", new Error("net::ERR_NETWORK_CHANGED"));
    fail();
    vi.advanceTimersByTime(5_000);
    fail();
    vi.advanceTimersByTime(20_000);
    expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(2);

    // The third failure is terminal — the 6h re-check takes it from here.
    fail();
    vi.advanceTimersByTime(60_000);
    expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(2);
    expect(bridge.getStatus().phase).toBe("error");
  });

  // A signature failure, a corrupt zip or a full disk fails identically every
  // time. Retrying those just delays the honest answer by 25 seconds.
  it("does NOT retry a failure that would repeat", async () => {
    const { bridge, emit } = await boot();
    emit("update-available", { version: "0.1.2" });
    emit("download-progress", { percent: 40 });

    emit("error", new Error("sha512 checksum mismatch"));
    vi.advanceTimersByTime(60_000);

    expect(fakeAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(bridge.getStatus().phase).toBe("error");
  });

  it("does not retry an error that arrives outside a download", async () => {
    const { emit } = await boot();
    // A failed CHECK — nothing was in flight to retry.
    emit("error", new Error("net::ERR_NETWORK_CHANGED"));
    vi.advanceTimersByTime(60_000);
    expect(fakeAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  // The consent is waiting ON the download, so it is not a reason to skip it.
  it("keeps a requested restart alive across a retry", async () => {
    const { bridge, emit } = await boot();
    emit("update-available", { version: "0.1.2" });
    emit("download-progress", { percent: 40 });
    bridge.restart!();

    emit("error", new Error("net::ERR_NETWORK_CHANGED"));
    vi.advanceTimersByTime(5_000);
    expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);

    emit("update-downloaded", { version: "0.1.2" });
    vi.advanceTimersByTime(2_500);
    expect(fakeAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("gives a new version its own retry budget", async () => {
    const { emit } = await boot();
    emit("update-available", { version: "0.1.2" });
    emit("download-progress", { percent: 40 });
    emit("error", new Error("net::ERR_NETWORK_CHANGED"));
    vi.advanceTimersByTime(5_000);
    emit("error", new Error("net::ERR_NETWORK_CHANGED"));
    vi.advanceTimersByTime(20_000);
    expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(2);

    // A later check finds 0.1.4 — a fresh subject, not a spent one.
    emit("update-available", { version: "0.1.4" });
    emit("download-progress", { percent: 10 });
    emit("error", new Error("net::ERR_NETWORK_CHANGED"));
    vi.advanceTimersByTime(5_000);
    expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(3);
  });
});
