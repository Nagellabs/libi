import { defineConfig } from "@playwright/test";
import fs from "fs";
import path from "path";
import os from "os";
import {
  assertPortPairFree,
  claimScratch,
  createDirIfAbsent,
  makeOwnedTempDir,
  rememberNextEnvDts,
  runnerBrowsersPath,
} from "./e2e/support/harness";

/**
 * Playwright config for Libi end-to-end tests.
 *
 * Spawns the Next.js dev server against a scratch LIBI_HOME so tests
 * can't pollute the developer's real `~/.libi/` directory.
 *
 * Environment:
 * - LIBI_E2E_PORT — port the spawned libi listens on; its MCP endpoint takes
 *   the next one. Defaults to 3465 (MCP 3466): 3456/3457 belong to the
 *   canonical libi, and a worktree's dev libi starts at 3461. Written back
 *   into process.env like the values below, so the specs read the same port.
 *   Both ports must be free — the config refuses to start otherwise.
 * - LIBI_E2E_HOME — the scratch LIBI_HOME. Set it to reuse or inspect a known
 *   directory; otherwise a fresh `libi-e2e-<timestamp>` under the OS temp dir
 *   is created and written back into process.env, so the workers Playwright
 *   re-loads this config in share the same home.
 * - LIBI_TEST_AGENT_CLI_DIRS — the ONE folder the spawned libi searches for an
 *   agent CLI instead of PATH (e2e/helpers/fake-cli.ts plants fakes there).
 *   Defaults to `<scratch home>-fake-cli`, written back the same way.
 */
// `??=` so the value survives Playwright re-loading this config in each worker.
const e2ePort = (process.env.LIBI_E2E_PORT ??= "3465");
// The spawned `next dev` points next-env.d.ts at its own Next dir; the global
// teardown puts it back (e2e/support/harness.ts).
rememberNextEnvDts();
const e2eMcpPort = String(Number(e2ePort) + 1);

// Both ports must be free: see assertPortPairFree (e2e/support/harness.ts).
assertPortPairFree({ port: e2ePort, mcpPort: e2eMcpPort, checkedVar: "LIBI_E2E_PORTS_CHECKED", portVar: "LIBI_E2E_PORT" });
// A dir the caller named is theirs to keep; only one THIS config creates is
// removed after the run (see "owned by construction" in e2e/support/harness.ts).
const namedHome = process.env.LIBI_E2E_HOME !== undefined;
const namedCliDir = process.env.LIBI_TEST_AGENT_CLI_DIRS !== undefined;
// `??=` so the value survives Playwright re-loading this config in each worker.
const scratchHome = (process.env.LIBI_E2E_HOME ??= makeOwnedTempDir(os.tmpdir(), "libi-e2e"));
// Beside the scratch home, never inside it: the resolver treats everything under
// LIBI_HOME as libi's own tree and never reports a CLI there as the user's.
// path.resolve drops a trailing slash that would otherwise put it inside the home.
// The scratch home must not live under the repo either: the repo cwd is also a libi root.
const fakeCliDir = (process.env.LIBI_TEST_AGENT_CLI_DIRS ??= path.resolve(scratchHome) + "-fake-cli");
const createdCliDir = !namedCliDir && createDirIfAbsent(fakeCliDir);
fs.mkdirSync(fakeCliDir, { recursive: true });
claimScratch(e2ePort, [...(namedHome ? [] : [scratchHome]), ...(createdCliDir ? [fakeCliDir] : [])]);
// The user-level skill installs go under the agent's HOME (`~/.agents/skills`
// for Codex) and under CLAUDE_CONFIG_DIR: both must be scratch, never the
// developer's own. Written back into process.env like the others so every
// worker and the specs agree on it.
const scratchUserHome = (process.env.LIBI_E2E_USER_HOME ??= path.join(scratchHome, "home"));
fs.mkdirSync(scratchUserHome, { recursive: true });

// social-posting.spec.ts needs the fake Zernio MCP (LIBI_TEST_MODE=1) plus one
// scenario override — the fake fails every TikTok publish with a fixed
// provider message (`mcp/dev/fake-zernio/config.ts#failTarget`) — so that spec
// can exercise "retry a failed target and see the provider's message
// verbatim" without any other target ever failing. No other spec in this
// directory talks to Zernio, so this is inert for the rest of the suite.
const fakeZernioConfigPath = (process.env.LIBI_FAKE_ZERNIO_CONFIG ??= path.join(scratchHome, "fake-zernio-config.json"));
fs.writeFileSync(
  fakeZernioConfigPath,
  JSON.stringify({
    failTarget: { platform: "tiktok", errorMessage: "TikTok rejected this video: it failed automated content review." },
  }),
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default defineConfig({
  testDir: "./e2e",
  // e2e/electron/ belongs to playwright.electron.config.ts (`npm run test:electron`),
  // which launches the desktop shell against a studio the harness started, with
  // LIBI_PORT and a scratch LIBI_HOME. Collected here they get neither: the shell
  // falls back to port 3456 and the specs to `~/.libi` — a developer's real libi
  // and home, or nothing at all (every launch then waits out its timeout).
  // A RegExp anchored to THIS folder: a string glob is matched as `**/<glob>`
  // against the absolute path, so "electron/**" also ignored every spec of a
  // checkout that merely lives under some `electron` directory.
  testIgnore: new RegExp(`^${escapeRegExp(path.join(__dirname, "e2e", "electron") + path.sep)}`),
  timeout: 60_000,
  globalTeardown: "./e2e/support/global-teardown.ts",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${e2ePort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node bin/libi.js",
    port: Number(e2ePort),
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      // Its own Next dir (next.config.ts `distDir`): Next locks `<distDir>/dev`
      // for one dev server, so on the shared `.next` this server died with
      // "Another next dev server is already running" whenever the checkout's
      // own dev app was up.
      LIBI_NEXT_DIST_DIR: ".next-e2e",
      LIBI_HOME: scratchHome,
      // Chromium for the spawned libi's own render/tracking launches — see
      // runnerBrowsersPath() in e2e/support/harness.ts.
      PLAYWRIGHT_BROWSERS_PATH: runnerBrowsersPath(),
      PORT: e2ePort,
      // Inside a git worktree bin/libi.js's bootstrap picks its own studio
      // port (3461, …) unless the shell already exported LIBI_PORT — without
      // this the spawned libi listens on 3461 while Playwright waits on e2ePort
      // until webServer.timeout (measured 2026-09-07). Pinning it keeps the
      // baseURL and the server on the same port from any checkout.
      LIBI_PORT: e2ePort,
      // libi's MCP endpoint listens on its own port; keep it beside the studio's.
      LIBI_MCP_PORT: e2eMcpPort,
      // The e2e specs drive /api/e2e/run-tool, now gated on this flag
      // (no longer on NODE_ENV). Opt the spawned libi in.
      LIBI_ENABLE_TEST_ROUTES: "1",
      // Agent CLIs are looked up only here (honoured because test routes are on),
      // so a spec decides whether claude/codex exist, not the machine running it.
      LIBI_TEST_AGENT_CLI_DIRS: fakeCliDir,
      // Claude's config is read from the scratch home, not the developer's own
      // `~/.claude.json`: a libi entry registered there would turn the wizard's
      // Connect step into Reconnect.
      CLAUDE_CONFIG_DIR: path.join(scratchHome, "claude-config"),
      HOME: scratchUserHome,
      // Swaps fal-ai/ElevenLabs for local fakes and starts the fake Zernio
      // MCP (mcp/dev/fake-zernio) that social-posting.spec.ts drives — see
      // `lib/social/test-fake.ts`.
      LIBI_TEST_MODE: "1",
      // Not a fully clean environment: this skips only the worktree bootstrap's
      // merge of the MAIN checkout's `.env.local` / `.env`
      // (lib/dev/worktree-bootstrap.ts). Next's own loader still reads `.env*`
      // from the checkout it boots in — the canonical checkout's, when run there.
      LIBI_NO_ENV_FILES: "1",
      LIBI_FAKE_ZERNIO_CONFIG: fakeZernioConfigPath,
    },
  },
});
