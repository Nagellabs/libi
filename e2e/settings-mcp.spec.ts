import { test, expect } from "./helpers/app";

test.describe("Agents — libi MCP tab", () => {
  test("Libi card renders with Core badge and dependency chips, no toggles", async ({ page }) => {
    await page.goto("/agents?tab=libi-mcp");

    const libiCard = page.locator("[data-testid=\"mcp-card-libi\"]");
    await expect(libiCard).toBeVisible({ timeout: 15_000 });

    // The libi MCP tab, reached by the `?tab=libi-mcp` deep link.
    await expect(page.getByRole("tab", { name: /^libi MCP$/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Core badge.
    await expect(libiCard.getByText(/^Core$/)).toBeVisible();

    // ffmpeg and ffprobe chips exist — whether installed or missing, the chips render.
    await expect(libiCard.getByText(/^ffmpeg$/)).toBeVisible();
    await expect(libiCard.getByText(/^ffprobe$/)).toBeVisible();

    // The core row has no enable / approval toggles of its own (the nested
    // extension rows carry their approval switches, asserted below).
    await expect(libiCard.locator("[id^=\"enabled-\"]")).toHaveCount(0);
    await expect(libiCard.locator("[id^=\"approval-\"]")).toHaveCount(0);

    // No delete or edit icon button.
    await expect(libiCard.locator("button[aria-label=\"Delete\"]")).toHaveCount(0);
    await expect(libiCard.locator("button[aria-label=\"Edit\"]")).toHaveCount(0);

    // The retired sections and dialogs are gone, not merely hidden.
    await expect(page.getByRole("heading", { name: /^bundled$/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /^custom$/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /add mcp/i })).toHaveCount(0);
  });

  test("libi card nests the extension rows with dependency chips and no enable toggle", async ({
    page,
  }) => {
    await page.goto("/agents?tab=libi-mcp");
    const libi = page.getByTestId("mcp-card-libi");
    await expect(libi).toBeVisible({ timeout: 15_000 });

    const music = libi.getByTestId("extension-row-local-music");
    await expect(music).toBeVisible();
    await expect(music.getByRole("switch", { name: /require approval/i })).toBeVisible();
    await expect(music.getByRole("switch", { name: /^enabled?$/i })).toHaveCount(0);
    await expect(music.getByText(/ace-step/i).first()).toBeVisible();

    // The Chromium dependency card and the yt-dlp extension are rows too —
    // both driven by the registry's `kind`, not a hand-kept id list.
    await expect(libi.getByTestId("extension-row-libi-export")).toBeVisible();
    await expect(libi.getByTestId("extension-row-youtube-download")).toBeVisible();

    // The connect command moved to the Global setup tab with the agents' setup.
    await expect(page.getByText("npx @nagellabs/libi connect", { exact: true })).toHaveCount(0);
    await page.goto("/agents?tab=global-setup");
    await expect(page.getByText("npx @nagellabs/libi connect", { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test("libi.show_extension still scrolls to a nested extension row", async ({ page }) => {
    await page.goto("/agents?tab=libi-mcp");
    await expect(page.getByTestId("extension-row-local-music")).toBeVisible({ timeout: 15_000 });
    // The same DOM event the SSE bridge dispatches for a navigate_agents
    // notification with an extensionId.
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("libi:mcp-scroll-to", { detail: { mcpId: "local-music" } }),
      );
    });
    await expect(page.locator("#mcp-local-music")).toBeInViewport();
    await expect(page.locator("#mcp-local-music")).toHaveClass(/ring-2/);
  });
});
