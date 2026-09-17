import { test, expect } from "./helpers/app";

const PROVIDERS = ["fal", "higgsfield", "elevenlabs"] as const;

test.describe("Agents — Providers tab", () => {
  test("lists the three third-party providers and deep-links to one", async ({ page }) => {
    await page.goto("/agents?tab=providers");
    for (const id of PROVIDERS) {
      await expect(page.getByTestId(`provider-row-${id}`)).toBeVisible({ timeout: 30_000 });
    }
    await expect(page.getByTestId("provider-row-ace-step")).toHaveCount(0);
    // Higgsfield is a real provider with a hosted MCP server, signed in to with a Higgsfield account.
    const higgsfield = page.getByTestId("provider-row-higgsfield");
    await expect(higgsfield).toContainText("No key: you sign in with your Higgsfield account in your browser");
    await expect(higgsfield).not.toContainText("No MCP server published");
    await expect(higgsfield.getByRole("link", { name: /docs/i })).toHaveAttribute("href", "https://higgsfield.ai/mcp");
    await page.goto("/agents?tab=providers&provider=elevenlabs&from=sess-1");
    await expect(page.getByTestId("provider-row-elevenlabs")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("provider-row-fal")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /back to chat/i })).toBeVisible();
    await page.getByRole("button", { name: /show all providers/i }).click();
    await expect(page.getByTestId("provider-row-fal")).toBeVisible();
  });

  test("shows one agent at a time, picked with the Claude Code | Codex switch and kept in the URL", async ({ page }) => {
    await page.goto("/agents?tab=providers&setupAgent=claude-code");
    await expect(page.getByRole("tablist", { name: "Set up providers for" })).toBeVisible({ timeout: 30_000 });
    const claude = page.getByTestId("providers-agent-option-claude-code");
    const codex = page.getByTestId("providers-agent-option-codex");
    await expect(claude).toHaveAttribute("aria-selected", "true");
    await expect(codex).toHaveAttribute("aria-selected", "false");
    for (const id of PROVIDERS) {
      const row = page.getByTestId(`provider-row-${id}`);
      await expect(row.getByTestId(`chip-${id}-claude-code`)).toBeVisible({ timeout: 30_000 });
      await expect(row.getByTestId(`chip-${id}-codex`)).toHaveCount(0);
    }

    await codex.click();
    await expect(codex).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/[?&]setupAgent=codex(&|$)/);
    for (const id of PROVIDERS) {
      const row = page.getByTestId(`provider-row-${id}`);
      await expect(row.getByTestId(`chip-${id}-codex`)).toBeVisible();
      await expect(row.getByTestId(`chip-${id}-claude-code`)).toHaveCount(0);
    }

    // Leaving the tab and coming back keeps the pick.
    await page.getByRole("tab", { name: "Skills" }).click();
    await page.getByRole("tab", { name: "Providers" }).click();
    await expect(page.getByTestId("providers-agent-option-codex")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });

    // A deep link names the agent along with the provider.
    await page.goto("/agents?tab=providers&provider=higgsfield&setupAgent=codex");
    await expect(page.getByTestId("chip-higgsfield-codex")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("chip-higgsfield-claude-code")).toHaveCount(0);
  });
});
