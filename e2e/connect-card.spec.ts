import { test, expect } from "./helpers/app";

/**
 * The connect command on the Global setup tab, and the live endpoint on the
 * Libi MCP tab, after the move to one streamable-HTTP endpoint.
 *
 * A unit test can prove a tab renders whatever a mocked hook returns; only
 * this spec proves the endpoint shown is the one a real libi is serving —
 * the route, the aggregator child and the tab all have to agree, and the page
 * used to describe a `--connect-agent` flow that no longer exists.
 */
test.describe("Agents — connect command and live endpoint", () => {
  test("Global setup shows the one command; Libi MCP shows the live endpoint", async ({ page }) => {
    await page.goto("/agents?tab=global-setup");
    await expect(page.getByText("npx @nagellabs/libi connect", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("--connect-agent")).toHaveCount(0);

    await page.goto("/agents?tab=libi-mcp");
    // The endpoint the command registers, as this instance is actually serving it.
    await expect(
      page.locator("code").filter({ hasText: /^http:\/\/127\.0\.0\.1:\d+\/mcp$/ }).first(),
    ).toBeVisible({ timeout: 30_000 });
    // The retired flow must be gone from the page, not merely de-emphasised.
    await expect(page.getByText("--connect-agent")).toHaveCount(0);
  });
});
