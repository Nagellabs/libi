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

export default defineConfig({
  testDir: "./e2e",
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
    },
  },
});
