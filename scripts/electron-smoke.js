#!/usr/bin/env node
/**
 * Launch Electron via Playwright, navigate the UI, and capture:
 *   - All console messages
 *   - The first page error (if any)
 *   - A screenshot of the main window
 *
 * Used as a smoke test + control harness during the dev loop. Assumes
 * the Next.js dev server is already running on LIBI_PORT (default 3456)
 * — this script is intentionally lightweight; the full Playwright
 * config lives in playwright.electron.config.ts.
 */

const { _electron: electron } = require("playwright");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const MAIN = path.join(ROOT, "dist-electron", "electron", "main.js");
const OUT_DIR = path.join(ROOT, ".electron-smoke");

async function main() {
  if (!fs.existsSync(MAIN)) {
    console.error("[smoke] " + MAIN + " not found — run `npm run compile:electron` first.");
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, LIBI_PORT: process.env.LIBI_PORT ?? "3456" },
    timeout: 60_000,
  });

  app.on("console", (msg) => {
    console.log(`[main:${msg.type()}] ${msg.text()}`);
  });

  // Wait for the main window (skip splash if any).
  let mainWin = null;
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    const wins = app.windows();
    mainWin = wins.find((w) => {
      const url = w.url();
      return url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost");
    }) ?? null;
    if (mainWin) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!mainWin) {
    console.error("[smoke] FAIL: no main window appeared within 90s. Windows seen:");
    for (const w of app.windows()) console.error("  - " + w.url());
    await app.close();
    process.exit(1);
  }

  console.log("[smoke] main window URL: " + mainWin.url());

  const consoleLog = [];
  const errors = [];
  mainWin.on("console", (msg) => {
    const line = `[renderer:${msg.type()}] ${msg.text()}`;
    consoleLog.push(line);
    console.log(line);
  });
  mainWin.on("pageerror", (err) => {
    errors.push(err.stack || err.message);
    console.error("[renderer:pageerror] " + (err.stack || err.message));
  });

  // Wait for the page to finish loading.
  try {
    await mainWin.waitForLoadState("networkidle", { timeout: 60_000 });
  } catch {
    console.warn("[smoke] networkidle timed out (still proceeding)");
  }

  await new Promise((r) => setTimeout(r, 2000));

  const platform = await mainWin.evaluate(() => {
    const api = window.electronAPI;
    return {
      hasApi: !!api,
      platform: api?.platform ?? null,
      title: document.title,
      url: window.location.href,
    };
  });
  console.log("[smoke] window probe:", platform);

  const screenshotPath = path.join(OUT_DIR, "main.png");
  await mainWin.screenshot({ path: screenshotPath, fullPage: false });
  console.log("[smoke] screenshot → " + screenshotPath);

  fs.writeFileSync(
    path.join(OUT_DIR, "console.log"),
    consoleLog.join("\n") + "\n",
  );
  if (errors.length > 0) {
    fs.writeFileSync(
      path.join(OUT_DIR, "errors.log"),
      errors.join("\n\n") + "\n",
    );
  }

  await app.close();

  if (errors.length > 0) {
    console.error("[smoke] FAIL: " + errors.length + " page error(s) — see .electron-smoke/errors.log");
    process.exit(2);
  }
  console.log("[smoke] OK");
}

main().catch((err) => {
  console.error("[smoke] launch failed:", err);
  process.exit(1);
});
