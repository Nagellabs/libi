/**
 * Tolerant Chromium launch for integration tests.
 *
 * Playwright browsers are a separate, out-of-band install (`npx playwright
 * install chromium`). When they are absent, `chromium.launch()` throws inside
 * `beforeAll`, which fails the WHOLE suite file — even though every test in it
 * already gates itself on `fixtureMissing()` and would have skipped.
 *
 * This turns that hard failure into a skip reason the tests can report, so an
 * unprovisioned machine says exactly what is missing instead of showing a red
 * suite. On a provisioned machine the launch succeeds and nothing changes.
 */

import { chromium, type Browser, type LaunchOptions } from "playwright-core";

export interface ChromiumLaunchAttempt {
  /** The live browser, or null when the launch failed. */
  browser: Browser | null;
  /** `null` on success; a human-readable skip reason on failure. */
  skipReason: string | null;
}

export async function tryLaunchChromium(
  options: LaunchOptions,
): Promise<ChromiumLaunchAttempt> {
  try {
    return { browser: await chromium.launch(options), skipReason: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Playwright's message is a multi-line banner ("Please run the following
    // command to download new browsers"). Keep the first line — it names the
    // exact executable path that is missing.
    const firstLine = message.split("\n")[0].trim();
    return {
      browser: null,
      skipReason: `playwright chromium unavailable — ${firstLine} (run \`npx playwright install chromium\`)`,
    };
  }
}
