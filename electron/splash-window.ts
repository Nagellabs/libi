// electron/splash-window.ts
//
// The splash BrowserWindow, extracted from `main.ts` so it can be created by
// something other than the packaged boot path.
//
// The splash is created ONLY in a packaged run — `main.ts`'s `app.on("ready")`
// returns early when `isDev`, and Playwright launches `main.js` unpackaged — so
// the Electron e2e used to build a BrowserWindow of its OWN and load
// `splash.html` into it. That test could not fail the way the splash actually
// failed: the packaged splash rendered no rows at all for a while, because
// of a preload/contextBridge mismatch, and a test that
// hand-writes its own `webPreferences` re-declares exactly the thing that was
// wrong. `main.ts` publishes this function as `globalThis.__libiCreateSplash`
// when unpackaged, so the spec renders the REAL window and the preload
// contract is under test.
//
// `__dirname` is the compiled `dist-electron/electron/` either way — this file
// is emitted beside `main.js`, `splash-preload.js` and `splash.html`.
import { BrowserWindow } from "electron";
import path from "path";

export function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 560,
    height: 640,
    resizable: false,
    frame: false,
    transparent: false,
    backgroundColor: "#09090b",
    // Splash should look like it belongs to the app, not a debug window.
    // Hide the dock icon's "loading" dot on macOS by giving the window
    // a clean shadow + center it on the active display.
    center: true,
    titleBarStyle: "hidden",
    // Isolate the splash renderer like the main window. It receives
    // lifecycle progress + can quit via the `splash-preload.js` contextBridge,
    // NOT via `require("electron")` / raw node integration.
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "splash-preload.js"),
    },
  });
  splash.loadFile(path.join(__dirname, "splash.html"));
  return splash;
}
