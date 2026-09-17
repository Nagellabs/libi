import { test, expect } from "./helpers/app";
import { plantFakeClaude, removeFakeClaude, removeFakeCliDir } from "./helpers/fake-cli";

/**
 * The full wizard against a fake CLI on LIBI_TEST_AGENT_CLI_DIRS:
 * not found → install command waiting in the terminal → fake CLI placed →
 * Check again → sign in → Open chat, with the optional connect command waiting under it. Nothing is
 * executed: the setup terminal only ever holds the command at its prompt.
 *
 * xterm draws to a canvas and receives the command only after its first resize
 * and the login shell's startup, so the command is read from the terminal
 * container's `data-command`, not from the rendered text.
 */
test.describe("Agents — the wizard with a fake Claude", () => {
  // The persona question is answered by the shared `test` fixture (helpers/app.ts).
  test.beforeEach(() => {
    removeFakeClaude();
  });
  test.afterAll(() => removeFakeCliDir());

  test("walks steps 2 → 4", async ({ page }) => {
    await page.goto("/agents?tab=agents&agent=claude-code");
    await expect(page.getByText(/couldn.t find claude code on your path/i)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /^install$/i }).click();
    const term = page.getByTestId("setup-terminal-agents");
    // First POST /api/terminal/sessions + PTY spawn waits behind a cold dev compile.
    await expect(term).toBeVisible({ timeout: 15_000 });
    await expect(term).toHaveAttribute("data-action", "install");
    await expect(term).toHaveAttribute("data-command", "curl -fsSL https://claude.ai/install.sh | bash");
    await expect(page.getByRole("button", { name: /^next$/i })).toBeDisabled();

    plantFakeClaude("99.0.0");
    await page.getByRole("button", { name: /check again/i }).click();
    // Scoped to the step: the live status line above it shows the bare version too.
    await expect(page.getByTestId("wizard-step-install").getByText(/claude code 99\.0\.0 is installed/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: /^next$/i })).toBeEnabled({ timeout: 15_000 });
    await page.getByRole("button", { name: /^next$/i }).click();

    await expect(page.getByText(/step 3 of 4/i)).toBeVisible();
    await page.getByRole("button", { name: /i.m already signed in/i }).click();

    // The sign-in-confirmation route compiles on this first click.
    await expect(page.getByText(/step 4 of 4 — open chat/i)).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: /^connect$/i }).click();
    await expect(term).toHaveAttribute("data-action", "connect-libi");
    await expect(term).toHaveAttribute(
      "data-command",
      /mcp add --scope user --transport http libi http:\/\/127\.0\.0\.1:\d+\/mcp$/,
    );

    // A three-line fake `claude` cannot hold an ACP session, so the session create
    // fails and the wizard (correctly) does not navigate. What this spec can prove
    // is that the click reaches the start route for this agent; landing in the
    // editor needs a real CLI.
    const start = page.waitForRequest((r) => r.url().endsWith("/api/agent/start") && r.method() === "POST");
    await page.getByRole("button", { name: /open chat/i }).click();
    expect((await start).postDataJSON()).toEqual({ providerId: "claude-code" });
  });

  test("the status bar reflects the fake CLI and the confirmation", async ({ page }) => {
    plantFakeClaude("99.0.0");
    // Independent of the first test: store the confirmation here instead of relying on its click.
    const r = await page.request.post("/api/agents/claude-code/sign-in-confirmation");
    expect(r.ok()).toBe(true);
    // The rows are the tab once the wizard has been finished; a first onboarding shows the wizard alone.
    expect((await page.request.put("/api/onboarding/state", { data: { wizardFinished: true } })).ok()).toBe(true);
    await page.goto("/agents");
    const row = page.getByTestId("agent-status-row-claude-code");
    await expect(row.getByTestId("cell-installed")).toHaveText("99.0.0", { timeout: 30_000 });
    await expect(row.getByTestId("cell-signed-in")).toHaveText("Confirmed");
  });
});
