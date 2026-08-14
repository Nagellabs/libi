import { test, expect } from "@playwright/test";

test.describe("Settings — MCP Servers", () => {
  test("Libi card renders with Core badge and dependency chips, no toggles", async ({ page }) => {
    await page.goto("/settings");

    // The Settings page may use either a `role="tab"` selector or a text anchor.
    // Try clicking a tab with "MCP Servers" text; if no tab, the section is likely
    // always-visible and the click is a no-op.
    await page
      .getByRole("tab", { name: /mcp servers/i })
      .click()
      .catch(() => {});

    const libiCard = page.locator("[data-testid=\"mcp-card-libi\"]");
    await expect(libiCard).toBeVisible({ timeout: 15_000 });

    // Core badge.
    await expect(libiCard.getByText(/^Core$/)).toBeVisible();

    // ffmpeg and ffprobe chips exist — whether installed or missing, the chips render.
    await expect(libiCard.getByText(/^ffmpeg$/)).toBeVisible();
    await expect(libiCard.getByText(/^ffprobe$/)).toBeVisible();

    // No enable / approval toggles.
    await expect(libiCard.locator("[id^=\"enabled-\"]")).toHaveCount(0);
    await expect(libiCard.locator("[id^=\"approval-\"]")).toHaveCount(0);

    // No delete or edit icon button.
    await expect(libiCard.locator("button[aria-label=\"Delete\"]")).toHaveCount(0);
    await expect(libiCard.locator("button[aria-label=\"Edit\"]")).toHaveCount(0);
  });

  test("YouTube Downloader card still has toggles and yt-dlp chip", async ({ page }) => {
    await page.goto("/settings");
    await page
      .getByRole("tab", { name: /mcp servers/i })
      .click()
      .catch(() => {});

    const ytCard = page.locator("[data-testid=\"mcp-card-youtube-downloader\"]");
    await expect(ytCard).toBeVisible();
    // The enable toggle exists — Label + Switch both share `enabled-${id}` (label
    // via htmlFor targeting the switch element), so assert presence, not exact count.
    await expect(ytCard.locator("[id^=\"enabled-\"]").first()).toBeVisible();
    await expect(ytCard.getByText(/^yt-dlp$/)).toBeVisible();
  });
});
