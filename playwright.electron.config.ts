import { defineConfig } from "@playwright/test";

/**
 * Playwright config for Libi's Electron tests.
 *
 * Uses the `_electron` API exposed by `playwright` (NOT the standard
 * browser projects), so we deliberately leave `use.baseURL`/`browserName`
 * out — each test launches Electron itself via `_electron.launch(...)`.
 *
 * Assumes the Next dev server is already running on LIBI_PORT (default
 * 3456). The harness is intentionally NOT auto-starting a webServer: we
 * want the same `npm run dev` the developer is already using.
 */
export default defineConfig({
  testDir: "./e2e/electron",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
