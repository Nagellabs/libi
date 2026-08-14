import { test, expect } from "@playwright/test";
import { launchLibi } from "./helpers";

test.describe("Electron — TopBar + drag region", () => {
  test("full-width topbar exposes the drag region across the window", async () => {
    const { app, main } = await launchLibi();
    try {
      const topbar = main.locator("[data-topbar]");
      await expect(topbar).toBeVisible();

      // The bar itself must carry `-webkit-app-region: drag`.
      const region = await topbar.evaluate((el) =>
        getComputedStyle(el).getPropertyValue("-webkit-app-region").trim(),
      );
      expect(region).toBe("drag");

      // Full width — spans across the whole window above sidebar +
      // content. (Sidebar default is ~288px so we just sanity-check
      // that the bar is materially wider.)
      const win = main.viewportSize();
      const box = await topbar.boundingBox();
      expect(box).not.toBeNull();
      if (win) {
        expect(box!.width).toBeGreaterThan(win.width * 0.8);
      }
    } finally {
      await app.close();
    }
  });

  test("preload bridges window controls + platform info to the renderer", async () => {
    const { app, main } = await launchLibi();
    try {
      const probe = await main.evaluate(() => {
        const api = (window as unknown as {
          electronAPI?: {
            platform?: string;
            windowMinimize?: () => unknown;
            windowMaximize?: () => unknown;
            windowClose?: () => unknown;
            windowIsMaximized?: () => unknown;
          };
        }).electronAPI;
        return {
          hasApi: !!api,
          platform: api?.platform ?? null,
          hasMinimize: typeof api?.windowMinimize === "function",
          hasMaximize: typeof api?.windowMaximize === "function",
          hasClose: typeof api?.windowClose === "function",
          hasIsMaximized: typeof api?.windowIsMaximized === "function",
        };
      });
      expect(probe.hasApi).toBe(true);
      expect(["darwin", "win32", "linux"]).toContain(probe.platform);
      expect(probe.hasMinimize).toBe(true);
      expect(probe.hasMaximize).toBe(true);
      expect(probe.hasClose).toBe(true);
      expect(probe.hasIsMaximized).toBe(true);
    } finally {
      await app.close();
    }
  });

  test("sidebar starts below the topbar", async () => {
    const { app, main } = await launchLibi();
    try {
      const topbar = main.locator("[data-topbar]");
      const sidebar = main.locator("[data-slot=sidebar-container]").first();
      await expect(topbar).toBeVisible();
      await expect(sidebar).toBeVisible();

      const [topbarBox, sidebarBox] = await Promise.all([
        topbar.boundingBox(),
        sidebar.boundingBox(),
      ]);
      expect(topbarBox).not.toBeNull();
      expect(sidebarBox).not.toBeNull();
      // Sidebar top edge >= topbar bottom edge (tolerate 1 px rounding).
      expect(sidebarBox!.y).toBeGreaterThanOrEqual(topbarBox!.y + topbarBox!.height - 1);
    } finally {
      await app.close();
    }
  });
});
