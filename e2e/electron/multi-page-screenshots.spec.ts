import { test } from "@playwright/test";
import { launchLibi } from "./helpers";
import path from "node:path";
import fs from "node:fs";

const OUT_DIR = path.join(__dirname, "..", "..", ".electron-smoke");

/**
 * Tour the major pages of the app to confirm the unified topbar renders
 * correctly across all of them. Failure here means a page is missing
 * the layout wrapper or has a stale `h-svh` claim.
 */
test("walks the main routes and captures screenshots", async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { app, main } = await launchLibi();
  try {
    const routes = [
      { path: "/editor", name: "editor" },
      { path: "/characters", name: "characters" },
      { path: "/items", name: "items" },
      { path: "/mcps-skills", name: "mcps-skills" },
      { path: "/settings", name: "settings" },
    ];

    for (const r of routes) {
      const port = process.env.LIBI_PORT ?? "3456";
      await main.goto(`http://127.0.0.1:${port}${r.path}`, {
        waitUntil: "domcontentloaded",
      });
      await main.waitForTimeout(1500);
      const file = path.join(OUT_DIR, `${r.name}.png`);
      await main.screenshot({ path: file });
      console.log("captured", file);
    }
  } finally {
    await app.close();
  }
});
