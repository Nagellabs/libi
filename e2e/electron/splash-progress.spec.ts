import path from "node:path";
import { test, expect, _electron as electron } from "@playwright/test";

/**
 * The splash is created ONLY in a packaged run (`electron/main.ts`'s
 * `app.on("ready")` returns early when `isDev`), and Playwright launches
 * `main.js` unpackaged — so no ordinary spec renders it.
 *
 * This calls the REAL `createSplash()` out of `electron/splash-window.ts`.
 * The previous version built a `BrowserWindow` of its own with its own
 * `webPreferences` and its own `preload:` path, which meant the one thing the
 * splash has actually got wrong in production was the one thing the test could
 * not catch: the packaged splash rendered NO rows for a while, on a
 * preload/contextBridge mismatch. A test that re-declares the preload wiring
 * re-declares the bug away.
 *
 * Synthetic events are still pushed down the same `"lifecycle"` IPC channel
 * `lib/server/lifecycle/adapters/electron.ts` uses — that part was never the
 * problem. Everything under test now — the window, its preload, the bridge,
 * the row template, the meta column — is production code.
 *
 * Unpackaged, main.ts's dev branch polls LIBI_PORT for a studio for 60s and
 * then quits; nothing here needs that studio, and the assertions finish long
 * before the poll gives up. LIBI_CDP=0 keeps main.ts off port 9222 so a
 * developer-side `preview_start("Libi Electron")` is not disturbed.
 */
const DIST = path.resolve(__dirname, "../../dist-electron/electron");

test("splash renders a percentage next to the byte counts", async () => {
  const app = await electron.launch({
    args: [path.join(DIST, "main.js")],
    env: { ...process.env, LIBI_CDP: "0" },
  });
  try {
    const [splash] = await Promise.all([
      app.waitForEvent("window", {
        predicate: (page) => page.url().endsWith("splash.html"),
      }),
      app.evaluate(async () => {
        // The production factory, with production's `webPreferences` and
        // production's `preload:` path — not a copy written here.
        //
        // Reached through the `__libiCreateSplash` global `main.ts` publishes
        // when unpackaged: Playwright runs this function through `eval` in the
        // main process, where neither `require` (per-module in CommonJS) nor
        // `process.mainModule` exists, so there is no way to load a module
        // from in here.
        const createSplash = (globalThis as typeof globalThis & {
          __libiCreateSplash?: () => Electron.BrowserWindow;
        }).__libiCreateSplash;
        if (!createSplash) {
          throw new Error(
            "main.js did not publish __libiCreateSplash — is this an unpackaged build?",
          );
        }
        const w = createSplash();
        await new Promise<void>((r) => w.webContents.once("did-finish-load", () => r()));

        const item = { id: "ffmpeg", label: "ffmpeg", kind: "binary" };
        w.webContents.send("lifecycle", { kind: "category-a-install-start", item });
        // The FIRST tick of every download carries 0 bytes: it must
        // render "0 B", not an empty string with a stray leading space.
        w.webContents.send("lifecycle", {
          kind: "category-a-install-progress",
          item,
          bytesDownloaded: 0,
          bytesTotal: 132_000_000,
        });
        w.webContents.send("lifecycle", {
          kind: "category-a-install-progress",
          item,
          bytesDownloaded: 42_000_000,
          bytesTotal: 132_000_000,
        });
        w.webContents.send("lifecycle", {
          kind: "category-a-install-done",
          item: { id: "ffprobe", label: "ffprobe", kind: "binary" },
          result: "skipped",
          reason: "already installed",
        });
      }),
    ]);

    const ffmpegMeta = splash.locator('[data-key="i:ffmpeg"] .meta');
    await expect(ffmpegMeta).toHaveText("40.1 MB / 125.9 MB · 32%");

    // A dep decided on disk arrives as done/skipped with no preceding start.
    const ffprobeRow = splash.locator('[data-key="i:ffprobe"]');
    await expect(ffprobeRow).toHaveClass(/skipped/);
    await expect(ffprobeRow.locator(".meta")).toHaveText("ready");

    // The probe phase is gone — there is no "Verify" section left to
    // render an empty list into.
    await expect(splash.locator("#probes")).toHaveCount(0);
    await expect(splash.locator(".section-title", { hasText: "Install" })).toHaveCount(1);
  } finally {
    await app.close();
  }
});
