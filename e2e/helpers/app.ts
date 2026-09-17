import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import path from "path";

export { expect };

/** Path to the committed test fixture (`__tests__/helpers/fixtures/tiny.mp4`). */
export function fixturePath(name: string): string {
  return path.resolve(__dirname, "..", "..", "__tests__", "helpers", "fixtures", name);
}

/**
 * Answers the first-launch persona question through the product route. A home
 * that never answered it is a first launch: `/editor` is routed to the Agents tab,
 * and the question sits over every Agents page, in front of whatever a spec means
 * to click. playwright.config.ts gives each run a fresh home unless LIBI_E2E_HOME
 * is set, so no spec may count on an earlier one having answered it.
 */
export async function answerPersona(request: APIRequestContext): Promise<void> {
  const res = await request.put("/api/onboarding/persona", { data: { persona: "developer" } });
  expect(res.ok()).toBe(true);
}

/**
 * `test` for every spec that opens a libi page: each test starts as a user who
 * has already answered the persona question, whichever spec runs first, or alone.
 * The first-launch test in agents-page.spec.ts undoes that inside its own body and
 * puts it back when it finishes.
 */
export const test = base.extend<{ personaAnswered: void }>({
  personaAnswered: [
    async ({ request }, use) => {
      await answerPersona(request);
      await use();
    },
    { auto: true },
  ],
});

/**
 * Navigate to the editor and wait for it to be interactive.
 * Requires `data-testid="editor-panel"` on the editor root. Answers the persona
 * question first, so it also serves specs that import `test` from Playwright itself.
 */
export async function openEditor(page: Page): Promise<void> {
  await answerPersona(page.request);
  await page.goto("/editor");
  await expect(page.locator("[data-testid=\"editor-panel\"]")).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Upload a fixture file via the resources panel's file input.
 * Requires `data-testid="resources-upload-input"` on the file input.
 */
export async function uploadFile(page: Page, fixtureName: string): Promise<void> {
  const input = page.locator("[data-testid=\"resources-upload-input\"]");
  await input.setInputFiles(fixturePath(fixtureName));
  await expect(
    page.locator(`[data-testid="asset-row"]:has-text("${fixtureName}")`),
  ).toBeVisible({ timeout: 15_000 });
}
