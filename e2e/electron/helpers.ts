import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(__dirname, "..", "..");
const MAIN = path.join(ROOT, "dist-electron", "electron", "main.js");

export interface LaunchedApp {
  app: ElectronApplication;
  main: Page;
}

/**
 * Launch the libi Electron app against the running dev server. Resolves
 * once the main (non-splash) window has finished loading.
 *
 * The compiled main bundle MUST exist at `dist-electron/electron/main.js`
 * — run `npm run compile:electron` once before invoking `npm run
 * test:electron`. The npm script wires this for you.
 */
export async function launchLibi(): Promise<LaunchedApp> {
  if (!fs.existsSync(MAIN)) {
    throw new Error(
      `${MAIN} not found — run 'npm run compile:electron' first.`,
    );
  }
  const app = await electron.launch({
    args: [MAIN],
    env: {
      ...process.env,
      LIBI_PORT: process.env.LIBI_PORT ?? "3456",
      // The test owns its own Playwright session via _electron.launch();
      // disable main.ts's --remote-debugging-port=9222 switch so we don't
      // collide with a developer-side `preview_start("Libi Electron")`
      // also running CDP on 9222. Playwright attaches via its own
      // debug port internally regardless.
      LIBI_CDP: "0",
    },
    timeout: 60_000,
  });

  // Wait for the main window (skip splash if it shows up in production).
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    const wins = app.windows();
    const found = wins.find((w) => {
      const url = w.url();
      return url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost");
    });
    if (found) {
      try {
        await found.waitForLoadState("domcontentloaded", { timeout: 30_000 });
      } catch {
        // ignore — page may be partly hydrated
      }
      return { app, main: found };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Main window did not appear within 90s");
}
