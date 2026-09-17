import { test, expect } from "./helpers/app";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { plantFakeClaude, removeFakeClaude, removeFakeCliDir } from "./helpers/fake-cli";

/**
 * libi's skills for the user's OWN Claude Code / Codex, written by the app
 * itself: the wizard's part 2 and the Global setup tab install into a temp folder
 * (typed into the path field — the native dialog cannot be driven headlessly)
 * and into the scratch user-level dirs, and Remove takes the files away.
 * Every path is scratch: HOME and CLAUDE_CONFIG_DIR come from
 * playwright.config.ts, LIBI_HOME is the e2e home.
 */
const claudeConfigDir = path.join(process.env.LIBI_E2E_HOME!, "claude-config");
const userHome = process.env.LIBI_E2E_USER_HOME!;
// playwright.config.ts writes its port back into process.env; the MCP endpoint takes the next one.
const mcpPort = Number(process.env.LIBI_E2E_PORT ?? "3465") + 1;

function tempProject(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "libi-e2e-proj-")));
}

type InstallRow = { id: string; agentId: string; scope: string; folderPath: string | null };

/** Deletes recorded folder installs matching `keep` through libi's own API, the same path Remove takes. */
async function removeFolderInstalls(page: import("@playwright/test").Page, match: (i: InstallRow) => boolean): Promise<void> {
  const list = await page.request.get("/api/agents/skill-installs");
  if (!list.ok()) return;
  const { installs } = (await list.json()) as { installs: InstallRow[] };
  for (const i of installs.filter((x) => x.scope === "folder" && match(x))) {
    await page.request.delete(`/api/agents/skill-installs/${i.id}`);
  }
}

/** A recorded folder is the realpath libi resolved, and macOS temp dirs live under /private/var. */
function sameFolder(recorded: string | null, folder: string): boolean {
  if (!recorded) return false;
  let real = folder;
  try { real = fs.realpathSync(folder); } catch { /* already removed */ }
  return recorded === folder || recorded === real;
}

test.describe("Skills for the user's own agents", () => {
  test.afterAll(() => removeFakeCliDir());

  // The wizard test stores a sign-in confirmation in the scratch DB, which
  // every later spec shares — agents-wizard.spec.ts walks step 3, which a
  // stored confirmation skips — and a reused LIBI_E2E_HOME keeps. So when the
  // DB held none before, it is taken back out, through the e2e-only route
  // (the product route has no undo).
  let confirmedHere = false;
  test.afterEach(async ({ request }) => {
    if (!confirmedHere) return;
    confirmedHere = false;
    const r = await request.delete("/api/e2e/agents/claude-code/sign-in-confirmation");
    expect(r.ok()).toBe(true);
  });

  test("wizard step 4: once the tools are connected, a specific folder gets the skills", async ({ page }) => {
    plantFakeClaude("99.0.0");
    // A registration in the scratch Claude config makes the tools read Connected on this port.
    fs.mkdirSync(claudeConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeConfigDir, ".claude.json"),
      JSON.stringify({ mcpServers: { libi: { type: "http", url: `http://127.0.0.1:${mcpPort}/mcp` } } }),
    );
    const status = await page.request.get("/api/agents/status?agent=claude-code");
    expect(status.ok()).toBe(true);
    const { agents } = (await status.json()) as { agents: { "claude-code"?: { signIn: { confirmedAt: string | null } } } };
    const r = await page.request.post("/api/agents/claude-code/sign-in-confirmation");
    confirmedHere = !agents["claude-code"]?.signIn.confirmedAt;
    expect(r.ok()).toBe(true);
    const project = tempProject();
    try {
      await page.goto("/agents?tab=agents&agent=claude-code");
      await expect(page.getByText(/step 4 of 4 — open chat/i)).toBeVisible({ timeout: 30_000 });
      const part = page.getByTestId("wizard-install-skills");
      await expect(part).toBeVisible({ timeout: 15_000 });
      await expect(part.getByRole("button", { name: /skip/i })).toHaveCount(0);
      await part.getByRole("radio", { name: /a specific folder/i }).check();
      await part.getByRole("textbox").fill(project);
      await part.getByRole("button", { name: /^install$/i }).click();
      await expect(part.getByTestId("wizard-install-skills-summary")).toHaveText("Skills installed in 1 folder", { timeout: 15_000 });
      const manage = part.getByRole("link", { name: /manage on the global setup tab/i });
      await expect(manage).toHaveAttribute("href", "/agents?tab=global-setup&setupAgent=claude-code");
      const manifest = path.join(project, ".claude", "skills", ".libi-managed.json");
      expect(fs.existsSync(manifest)).toBe(true);
      expect((JSON.parse(fs.readFileSync(manifest, "utf-8")) as { managed: string[] }).managed.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(project, ".agents", "skills"))).toBe(false);

      // The link opens the Global setup tab on Claude Code. Claude Code is also
      // this wizard's default agent when no sidebar agent is set, so the
      // aria-selected check below would pass even without `setupAgent` in the
      // URL — it's the href assertion above that actually pins the param. The
      // install is listed there, and Remove takes the files away.
      await manage.click();
      await expect(page).toHaveURL(/[?&]tab=global-setup(&|$)/, { timeout: 30_000 });
      await expect(page.getByTestId("global-setup-agent-option-claude-code")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
      const card = page.getByTestId("libi-agent-card-claude-code");
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("libi-agent-card-codex")).toHaveCount(0);
      const folderRow = card.getByTestId("skills-folders-row-claude-code");
      await expect(folderRow.getByText(path.join(project, ".claude", "skills"))).toBeVisible({ timeout: 15_000 });
      await expect(folderRow.getByText("Up to date", { exact: true })).toBeVisible();
      await folderRow.getByRole("button", { name: /^remove$/i }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: /^remove$/i }).click();
      await expect(folderRow.getByText(path.join(project, ".claude", "skills"))).toHaveCount(0, { timeout: 15_000 });
      expect(fs.existsSync(path.join(project, ".claude", "skills"))).toBe(false);
    } finally {
      // A failure above must not leave this folder's install behind for the next test.
      await removeFolderInstalls(page, (i) => sameFolder(i.folderPath, project));
      fs.rmSync(project, { recursive: true, force: true });
      fs.rmSync(path.join(claudeConfigDir, ".claude.json"), { force: true });
      removeFakeClaude();
    }
  });

  test.describe("Global setup tab", () => {
    for (const agent of ["claude-code", "codex"] as const) {
      const dialect = agent === "claude-code" ? ".claude" : ".agents";
      const userDir = agent === "claude-code" ? path.join(claudeConfigDir, "skills") : path.join(userHome, ".agents", "skills");

      test(`${agent}: add a folder, install for every folder (removing the folder), remove`, async ({ page }) => {
        const project = tempProject();
        try {
          // Start from no folder installs for this agent, so "your 1 folder" below is this test's own.
          await removeFolderInstalls(page, (i) => i.agentId === agent);
          await page.goto("/agents?tab=global-setup");
          // One agent's list at a time: pick this agent in the switch first.
          await page.getByTestId(`global-setup-agent-option-${agent}`).click({ timeout: 30_000 });
          const card = page.getByTestId(`libi-agent-card-${agent}`);
          await expect(card).toBeVisible({ timeout: 30_000 });
          const folders = card.getByTestId(`skills-folders-row-${agent}`);
          await folders.getByRole("button", { name: /^add folder$/i }).click();
          await folders.getByRole("textbox").fill(project);
          await folders.getByRole("button", { name: /^add$/i }).click();
          await expect(folders.getByText(path.join(project, dialect, "skills"))).toBeVisible({ timeout: 15_000 });
          expect(fs.existsSync(path.join(project, dialect, "skills", ".libi-managed.json"))).toBe(true);

          const userRow = card.getByTestId(`skills-user-row-${agent}`);
          await expect(userRow.getByText("Not installed")).toBeVisible();
          await userRow.getByRole("button", { name: /^install$/i }).click();
          const dialog = page.getByRole("alertdialog");
          await expect(dialog).toContainText("This also removes libi's skills from your 1 folder, since every folder will have them.");
          await dialog.getByRole("button", { name: /^install$/i }).click();
          await expect(userRow.getByText(/^Installed · \d+ skills$/)).toBeVisible({ timeout: 15_000 });
          expect(fs.existsSync(path.join(userDir, ".libi-managed.json"))).toBe(true);
          expect(fs.existsSync(path.join(project, dialect, "skills"))).toBe(false);
          await expect(folders.getByRole("button", { name: /^add folder$/i })).toBeDisabled();
          await expect(folders.getByText("Skills are installed for every folder, so every folder already has them.")).toBeVisible();

          await userRow.getByRole("button", { name: /^remove$/i }).click();
          await expect(page.getByRole("alertdialog")).toContainText(`Removes libi's skills from ${userDir}. Skills you added there yourself stay.`);
          await page.getByRole("alertdialog").getByRole("button", { name: /^remove$/i }).click();
          await expect(userRow.getByText("Not installed")).toBeVisible({ timeout: 15_000 });
          expect(fs.existsSync(path.join(userDir, ".libi-managed.json"))).toBe(false);
          await expect(folders.getByRole("button", { name: /^add folder$/i })).toBeEnabled();
        } finally {
          fs.rmSync(project, { recursive: true, force: true });
        }
      });
    }
  });
});
