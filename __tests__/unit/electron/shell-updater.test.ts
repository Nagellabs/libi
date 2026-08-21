import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
}

let fakeApp: FakeApp;

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
  fakeApp = { isPackaged: false, getVersion: () => "1.0.0" };
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
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.LIBI_SHELL_UPDATE_FEED;
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
