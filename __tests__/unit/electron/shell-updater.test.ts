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
