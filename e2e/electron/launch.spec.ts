import { test, expect } from "@playwright/test";
import { launchLibi } from "./helpers";

test.describe("Electron — basic launch + page health", () => {
  test("main window loads the editor without page errors", async () => {
    const { app, main } = await launchLibi();
    const pageErrors: string[] = [];
    main.on("pageerror", (err) => pageErrors.push(err.stack ?? err.message));

    try {
      await main.waitForLoadState("domcontentloaded", { timeout: 30_000 });

      // Sanity: we landed on the SPA, not a 404 / blank.
      expect(main.url()).toMatch(/127\.0\.0\.1|localhost/);
      const title = await main.title();
      expect(title.length).toBeGreaterThan(0);

      // The sidebar's brand link must render — proves the app shell
      // hydrated even before any data loads.
      const sidebarBrand = main.locator("[data-slot=sidebar-container]").first();
      await expect(sidebarBrand).toBeVisible({ timeout: 20_000 });

      // No uncaught page errors during initial load.
      expect(pageErrors, pageErrors.join("\n\n")).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
