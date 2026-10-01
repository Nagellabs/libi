import { defineConfig } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  assertPortPairFree,
  claimScratch,
  createDirIfAbsent,
  makeOwnedTempDir,
  rememberNextEnvDts,
  runnerBrowsersPath,
} from "./e2e/support/harness";

/**
 * Playwright config for Libi's Electron tests (`npm run test:electron`).
 *
 * Uses the `_electron` API exposed by `playwright` (NOT the standard
 * browser projects), so we deliberately leave `use.baseURL`/`browserName`
 * out — each test launches Electron itself via `launchLibi()`
 * (e2e/electron/helpers.ts).
 *
 * The unpackaged shell starts no server of its own: its dev branch polls
 * LIBI_PORT for 60 s and then shows a modal "did not respond" dialog on the
 * owner's screen. So by default this config STARTS ITS OWN STUDIO, the way
 * playwright.config.ts does for the web specs:
 * - `node bin/libi.js` from this checkout, in test mode, on its own Next dir
 *   (`.next-electron-e2e`, so a dev app in the same checkout can keep running);
 * - a fresh scratch LIBI_HOME under `/tmp/` (libi-home-and-export.spec.ts runs
 *   only against one there) — `LIBI_ELECTRON_E2E_HOME` names it instead;
 * - studio port `LIBI_ELECTRON_E2E_PORT` (default 3477, clear of the worktree
 *   dev range 3456–3475) and its MCP endpoint on the next port; both must be free.
 * LIBI_PORT and LIBI_HOME are written back into process.env, so every worker,
 * spec and launched shell agrees on them.
 *
 * The studio also gets a scratch HOME, CLAUDE_CONFIG_DIR and agent-CLI folder,
 * as the web e2e server does: it reads no real `~/.claude.json`, finds no real
 * claude/codex, and its worktree bootstrap never prunes the real `~/.libi/worktrees`.
 * Every scratch dir the run made is removed once its studio has stopped.
 *
 * To ATTACH to a studio that is already running instead, export its LIBI_PORT
 * and its LIBI_HOME (AGENTS.md → Commands). Then there is NO webServer: a
 * studio that is not there is `launchLibi`'s "no studio on :<port>", never a
 * test-mode studio started quietly inside the home you named.
 */

// Decided once, in the runner, BEFORE this file writes LIBI_PORT itself: workers
// re-load the config with the value written back below.
const ownsServer = (process.env.LIBI_ELECTRON_E2E_OWNS_SERVER ??= process.env.LIBI_PORT ? "0" : "1") === "1";

if (!ownsServer && !process.env.LIBI_HOME) {
  throw new Error(
    `test:electron: LIBI_PORT=${process.env.LIBI_PORT} is set, so the specs attach to the studio on that port — ` +
      "but LIBI_HOME is not, and the specs read that studio's home (its port and mcp-port files). " +
      "Export the LIBI_HOME that studio runs on, or unset LIBI_PORT to let the harness start its own studio.",
  );
}

const port = ownsServer ? (process.env.LIBI_ELECTRON_E2E_PORT ??= "3477") : process.env.LIBI_PORT!;
const mcpPort = ownsServer ? String(Number(port) + 1) : (process.env.LIBI_MCP_PORT ?? String(Number(port) + 1));
if (ownsServer) {
  assertPortPairFree({ port, mcpPort, checkedVar: "LIBI_ELECTRON_E2E_PORTS_CHECKED", portVar: "LIBI_ELECTRON_E2E_PORT" });
}
const namedHome = process.env.LIBI_ELECTRON_E2E_HOME !== undefined;
// Under literally `/tmp/`, not `os.tmpdir()` (`/var/folders/…` on macOS):
// libi-home-and-export.spec.ts runs only against a home under `/tmp/`. mkdtemp,
// so two runs never share a home and a pre-planted name is never adopted.
const libiHome = ownsServer
  ? (process.env.LIBI_ELECTRON_E2E_HOME ??= makeOwnedTempDir("/tmp", "libi-electron-e2e"))
  : process.env.LIBI_HOME!;
// Beside the home, never inside it: the CLI resolver ignores anything under LIBI_HOME.
const fakeCliDir = `${path.resolve(libiHome)}-fake-cli`;
if (ownsServer) {
  fs.mkdirSync(path.join(libiHome, "home"), { recursive: true });
  // Only a dir THIS config creates is removed after the run (e2e/support/harness.ts).
  const createdCliDir = createDirIfAbsent(fakeCliDir);
  claimScratch(port, [...(namedHome ? [] : [libiHome]), ...(createdCliDir ? [fakeCliDir] : [])]);
}
process.env.LIBI_PORT = port;
process.env.LIBI_HOME = libiHome;
// The specs drive the shell through Playwright's own CDP connection. The dev
// shell otherwise opens a detached DevTools window beside every main window:
// a window on the owner's screen, and the two-front-ends SIGTRAP (AGENTS.md →
// Electron + CDP). Inherited by every shell a spec launches, launchLibi's or not.
process.env.LIBI_NO_DEVTOOLS ??= "1";
// The spawned `next dev` points next-env.d.ts at its own Next dir; the global
// teardown puts it back (e2e/support/harness.ts).
rememberNextEnvDts();

export default defineConfig({
  testDir: "./e2e/electron",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  globalTeardown: "./e2e/support/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: ownsServer
    ? {
        command: "node bin/libi.js",
        // Ready once the editor route answers, not just the port: a shell pointed
        // at a studio still compiling `/editor` would show its window blank.
        url: `http://127.0.0.1:${port}/editor`,
        reuseExistingServer: false,
        timeout: 180_000,
        env: {
          // Its own Next dir (next.config.ts `distDir`), beside `.next` (a dev app)
          // and `.next-e2e` (the web e2e server).
          LIBI_NEXT_DIST_DIR: ".next-electron-e2e",
          LIBI_HOME: libiHome,
          PORT: port,
          // Pinned, or the worktree bootstrap in bin/libi.js picks a port of its own.
          LIBI_PORT: port,
          LIBI_MCP_PORT: mcpPort,
          // Local fakes for every paid provider; nothing a spec does can spend money.
          LIBI_TEST_MODE: "1",
          // Scratch HOME / CLAUDE_CONFIG_DIR / agent-CLI folder (see the header).
          // The CLI folder is honoured only with the test routes on.
          HOME: path.join(libiHome, "home"),
          CLAUDE_CONFIG_DIR: path.join(libiHome, "claude-config"),
          LIBI_ENABLE_TEST_ROUTES: "1",
          LIBI_TEST_AGENT_CLI_DIRS: fakeCliDir,
          // Chromium for the studio's own render launches, from the runner's cache.
          PLAYWRIGHT_BROWSERS_PATH: runnerBrowsersPath(),
          // Not a fully clean environment: this skips only the worktree bootstrap's
          // merge of the MAIN checkout's `.env.local` / `.env`
          // (lib/dev/worktree-bootstrap.ts). Next's own loader still reads `.env*`
          // from the checkout it boots in — the canonical checkout's, when run there.
          LIBI_NO_ENV_FILES: "1",
        },
      }
    : undefined,
});
