import { defineConfig } from "@playwright/test";
import path from "path";
import os from "os";

/**
 * Playwright config for Libi end-to-end tests.
 *
 * Spawns the Next.js dev server against a scratch LIBI_HOME so tests
 * can't pollute the developer's real `~/.libi/` directory.
 */
const scratchHome = path.join(os.tmpdir(), `libi-e2e-${Date.now()}`);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3456",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node bin/libi.js",
    port: 3456,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      LIBI_HOME: scratchHome,
      PORT: "3456",
      // RC-B: the e2e specs drive /api/e2e/run-tool, now gated on this flag
      // (no longer on NODE_ENV). Opt the spawned libi in.
      LIBI_ENABLE_TEST_ROUTES: "1",
    },
  },
});
