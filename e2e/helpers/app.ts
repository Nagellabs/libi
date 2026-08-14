import { Page, expect } from "@playwright/test";
import path from "path";

/** Path to the committed test fixture (`__tests__/helpers/fixtures/tiny.mp4`). */
export function fixturePath(name: string): string {
  return path.resolve(__dirname, "..", "..", "__tests__", "helpers", "fixtures", name);
}

/**
 * Navigate to the editor and wait for it to be interactive.
 * Requires `data-testid="editor-panel"` on the editor root.
 */
export async function openEditor(page: Page): Promise<void> {
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
