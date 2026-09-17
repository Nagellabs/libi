import { test, expect } from "./helpers/app";

test.describe("Agents page — tabs, deep links, sidebar", () => {
  test("five tabs in order, Agents selected by default", async ({ page }) => {
    await page.goto("/agents");
    await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("tab")).toHaveText(["Agents", "Global setup", "Skills", "Libi MCP", "Providers"]);
    await expect(page.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
  });

  test("?tab=libi-mcp&extension=whisper opens the Libi MCP tab", async ({ page }) => {
    await page.goto("/agents?tab=libi-mcp&extension=whisper");
    await expect(page.getByRole("tab", { name: /^Libi MCP$/ })).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
    // The highlight ring fades after 1.5 s, so assert the scroll, not the class.
    await expect(page.getByTestId("extension-row-whisper")).toBeInViewport({ timeout: 15_000 });
  });

  test("the sidebar Agents link is active on /agents", async ({ page }) => {
    await page.goto("/agents?tab=skills");
    // SidebarMenuButton renders its `active` state as a `data-active` attribute.
    await expect(page.locator('a[href="/agents"][data-active]')).toBeVisible({ timeout: 15_000 });
  });

  test("/mcps-skills is gone (404, no redirect)", async ({ page }) => {
    const res = await page.goto("/mcps-skills");
    expect(res?.status()).toBe(404);
  });

  // The shared fixture answered the persona question, and every spec shares one
  // scratch DB, so this test forgets the first launch itself — an agent that ever
  // connected included, which alone would count as set up — and writes back exactly
  // what it found when it finishes, pass or fail.
  test("a first launch lands on the Agents tab with the persona question over it", async ({ page, request }) => {
    const reset = await request.delete("/api/e2e/onboarding");
    expect(reset.ok()).toBe(true);
    const { previous } = (await reset.json()) as { previous: unknown };
    try {
      await page.goto("/editor");
      // Routed before the editor paints, so the question is asked on the Agents tab itself.
      await expect(page).toHaveURL(/\/agents\?tab=agents/, { timeout: 30_000 });
      const question = page.getByRole("dialog", { name: "Welcome to libi" });
      await expect(question).toBeVisible({ timeout: 15_000 });
      await question.getByRole("button", { name: "Developer" }).click();
      await expect(question).toBeHidden({ timeout: 15_000 });
      await expect(page).toHaveURL(/\/agents\?tab=agents/);
      // A first onboarding is the wizard alone, at step 1, whatever is installed.
      await expect(page.getByTestId("agent-wizard-title")).toHaveText(/step 1 of 4/i, { timeout: 15_000 });
      await expect(page.getByTestId("agent-status-bar")).toHaveCount(0);
    } finally {
      expect((await request.put("/api/e2e/onboarding", { data: previous })).ok()).toBe(true);
    }
  });
});
