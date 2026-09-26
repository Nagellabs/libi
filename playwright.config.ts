import { defineConfig } from "@playwright/test";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

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
const e2eMcpPort = String(Number(e2ePort) + 1);

/**
 * The ports in `ports` something already accepts connections on, over
 * 127.0.0.1 or ::1. A config module can't await, so the probe is a short
 * synchronous child process; a refused (or unroutable) connect means free.
 */
function listeningPorts(ports: string[]): string[] {
  const probe = `
    const net = require("net");
    const open = new Set();
    const checks = process.argv.slice(1).flatMap((port) => ["127.0.0.1", "::1"].map((host) => new Promise((resolve) => {
      const socket = net.connect({ host, port: Number(port) });
      const done = (listening) => { socket.destroy(); if (listening) open.add(port); resolve(); };
      socket.setTimeout(1000, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    })));
    Promise.all(checks).then(() => process.stdout.write(JSON.stringify([...open])));
  `;
  const result = spawnSync(process.execPath, ["-e", probe, ...ports], { encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`e2e: could not check whether port ${ports.join(" / ")} is free: ${result.error?.message ?? result.stderr}`);
  }
  return (JSON.parse(result.stdout) as string[]).sort();
}

/**
 * Refuse to start when the studio port or the MCP port beside it is taken.
 * Playwright's own check covers only `webServer.port`, and nothing checked the
 * MCP port: under the old 3456 default a running libi held 3457, so the
 * spawned libi's MCP endpoint could not bind, and a spec that registers
 * `http://127.0.0.1:<port+1>/mcp` reached the other libi instead. Checked once,
 * in the runner process: its workers re-load this config while the spawned
 * libi holds both ports, so the checked pair is written back into process.env.
 */
if (process.env.LIBI_E2E_PORTS_CHECKED !== `${e2ePort},${e2eMcpPort}`) {
  const busy = listeningPorts([e2ePort, e2eMcpPort]);
  if (busy.length > 0) {
    throw new Error(
      `e2e: port ${busy.join(" and ")} ${busy.length > 1 ? "are" : "is"} already in use. The libi these tests spawn needs ${e2ePort} ` +
        `for the studio and ${e2eMcpPort} for its MCP endpoint, and a libi already listening there would answer the specs instead. ` +
        `Stop whatever holds it, or set LIBI_E2E_PORT to a port whose next port is free too.`,
    );
  }
  process.env.LIBI_E2E_PORTS_CHECKED = `${e2ePort},${e2eMcpPort}`;
}
// `??=` so the value survives Playwright re-loading this config in each worker.
const scratchHome = (process.env.LIBI_E2E_HOME ??= path.join(os.tmpdir(), `libi-e2e-${Date.now()}`));
// Beside the scratch home, never inside it: the resolver treats everything under
// LIBI_HOME as libi's own tree and never reports a CLI there as the user's.
// path.resolve drops a trailing slash that would otherwise put it inside the home.
// The scratch home must not live under the repo either: the repo cwd is also a libi root.
const fakeCliDir = (process.env.LIBI_TEST_AGENT_CLI_DIRS ??= path.resolve(scratchHome) + "-fake-cli");
fs.mkdirSync(fakeCliDir, { recursive: true });
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

/**
 * The Playwright browser cache the SPAWNED libi should use for its own
 * chromium-render / tracking launches.
 *
 * `webServer.env` gives that libi a scratch `HOME`, and playwright-core derives
 * its registry directory from the home — so without this it looks for Chromium
 * under a brand-new empty directory and every chromium-render path fails with
 * "Playwright Chromium failed to launch after install" (overlay-sandbox-golden
 * hit exactly that). Pointing it at the RUNNER's cache adds no new requirement:
 * these tests already need a Playwright browser install to drive a page, and it
 * saves a ~173 MB download into a directory each run throws away.
 *
 * Safe against libi's boot housekeeping: `pruneStalePlaywrightRevisions`
 * (lib/server/lifecycle/housekeeping.ts) removes only unpinned revisions
 * carrying libi's own `.libi-installed` marker file, never Playwright's.
 */
function runnerBrowsersPath(): string {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && override !== "0") return override;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Caches", "ms-playwright");
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "ms-playwright");
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "ms-playwright");
}

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
      LIBI_HOME: scratchHome,
      // Chromium for the spawned libi's own render/tracking launches — see
      // runnerBrowsersPath() above.
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
      LIBI_FAKE_ZERNIO_CONFIG: fakeZernioConfigPath,
    },
  },
});
