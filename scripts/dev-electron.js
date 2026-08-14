#!/usr/bin/env node
/**
 * Dev launcher for the Electron flow.
 *
 * Why this exists: `npm run dev:electron` cannot just be `concurrently`
 * because the worktree bootstrap (lib/dev/worktree-bootstrap.ts) sets
 * LIBI_HOME + LIBI_PORT inside the env of `bin/libi.js`'s grandchild.
 * The sibling Electron process never sees those values, so it would:
 *  - wait on the wrong port (3456 instead of the worktree's chosen port)
 *  - resolve `getLibiHome()` to `~/.libi` instead of the worktree home
 *  - get a different agent / database than the dev server is using
 *
 * Steps:
 *   1. Run `resolveWorktreeEnv()` once. Yields { libiHome, port,
 *      worktreeName, envOverrides } — or {} when not in a worktree.
 *   2. Compose a merged env (shell wins; bootstrap fills the gaps).
 *   3. Spawn `node bin/libi.js --port <port>` (the Next dev server) and
 *      `electron dist-electron/electron/main.js` with the SAME env.
 *      Both children now agree on LIBI_HOME and LIBI_PORT.
 *   4. Wait for the Next server on http://127.0.0.1:<port> before
 *      starting Electron so the splash bypass / waitForServer in main.ts
 *      doesn't time out.
 *
 * Ctrl-C kills both children; either child exiting kills the other.
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const { spawn, execFileSync } = require("node:child_process");
const { waitForServer } = require("./lib/wait-for-server");

const ROOT = path.resolve(__dirname, "..");
const MAIN = path.join(ROOT, "dist-electron", "electron", "main.js");

// Durable breadcrumb for HOW the dev stack came down. The `[dev-electron]`
// console lines only reach the preview/launcher's stdout buffer, which is
// discarded the instant the process tree dies — so a child exit code or an
// incoming SIGTERM (e.g. the launcher killing us) was previously unrecoverable.
// This appends to the same crash-safe file electron/main.ts writes.
function durableLog(line) {
  try {
    const logDir = path.join(
      process.env.LIBI_HOME || path.join(os.homedir(), ".libi"),
      "logs",
    );
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, "electron-main-sync.log"),
      `[${new Date().toISOString()}] [dev-electron] ${line}\n`,
    );
  } catch {
    /* never throw */
  }
}

// Name WHO terminated us. "parent/launcher killed us" was never enough to act
// on — investigations had to cross-reference the launcher's own logs by
// timestamp. Capturing ppid + the parent's command line (and whether we've been
// orphaned to launchd, i.e. the parent already died and this is group-cleanup)
// makes electron-main-sync.log self-explanatory: e.g. the Claude Code preview
// idle-reaper shows up here directly instead of as an anonymous SIGTERM.
function describeParent() {
  const ppid = process.ppid;
  let parentCmd = "(gone)";
  try {
    parentCmd =
      execFileSync("ps", ["-o", "command=", "-p", String(ppid)], {
        encoding: "utf-8",
      }).trim() || "(gone)";
  } catch {
    /* parent already reaped — leave "(gone)" */
  }
  const orphaned = ppid <= 1;
  return `ppid=${ppid}${orphaned ? " (orphaned → launchd; parent already exited)" : ""} parent=${JSON.stringify(parentCmd)}`;
}

// Normalize cwd to THIS checkout's root so the worktree bootstrap (which keys
// off process.cwd()) resolves the worktree this dev-electron belongs to — not
// the canonical repo a preview/launcher may have spawned us from.
try {
  process.chdir(ROOT);
} catch {
  /* best-effort */
}

function ensureCompiled() {
  if (fs.existsSync(MAIN)) return;
  console.log("[dev-electron] Compiling Electron bundle…");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-electron.js")], {
    stdio: "inherit",
    cwd: ROOT,
  });
}

async function resolveEnv() {
  // We resolve via the same TS module bin/libi.js uses, invoked through
  // tsx so we don't need a separate build step.
  const NODE = process.execPath;
  const TSX_SCRIPT = path.resolve(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const TSX = fs.existsSync(TSX_SCRIPT)
    ? TSX_SCRIPT
    : path.resolve(ROOT, "node_modules", ".bin", "tsx");
  const BOOTSTRAP = path.resolve(ROOT, "lib", "dev", "worktree-bootstrap.ts");

  // When there's no .git tree (installed npm package) the bootstrap
  // exits early and returns {}. We still need a port for wait-on, so we
  // fall back to the existing env or the default.
  let result = {};
  if (fs.existsSync(path.join(ROOT, ".git"))) {
    try {
      const json = execFileSync(
        NODE,
        [
          TSX,
          "--eval",
          `import { resolveWorktreeEnv } from ${JSON.stringify(BOOTSTRAP)}; resolveWorktreeEnv().then(r => process.stdout.write(JSON.stringify(r))).catch(() => process.stdout.write("{}"));`,
        ],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] },
      );
      result = JSON.parse(json || "{}");
    } catch (err) {
      console.warn("[dev-electron] worktree bootstrap failed:", err.message);
    }
  }

  // Build the merged env: shell exports win, bootstrap fills gaps.
  const env = { ...process.env };
  if (result.libiHome && !env.LIBI_HOME) env.LIBI_HOME = result.libiHome;
  if (typeof result.port === "number" && !env.LIBI_PORT)
    env.LIBI_PORT = String(result.port);
  // Per-worktree Electron CDP port so worktrees don't fight over 9222 (and the
  // worktree's .mcp.json playwright client attaches to ITS Electron).
  if (typeof result.cdpPort === "number" && !env.LIBI_CDP_PORT)
    env.LIBI_CDP_PORT = String(result.cdpPort);
  if (result.worktreeName) env.LIBI_WORKTREE_NAME = result.worktreeName;
  if (result.envOverrides) {
    for (const [k, v] of Object.entries(result.envOverrides)) {
      if (env[k] === undefined && typeof v === "string") env[k] = v;
    }
  }

  if (result.logLine) console.log(result.logLine);

  const port = Number.parseInt(env.LIBI_PORT ?? "3456", 10);
  const cdpPort = Number.parseInt(env.LIBI_CDP_PORT ?? "9222", 10);
  return { env, port, cdpPort };
}

/** Resolve once the given TCP port is free on 127.0.0.1, or after `timeoutMs`.
 *  A previous Electron releases its remote-debugging port a beat after exit;
 *  launching a new one onto an occupied CDP port races into a renderer crash
 *  (SIGTRAP). Best-effort: we proceed after the timeout rather than block. */
function waitForPortFree(port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const sock = net.connect({ host: "127.0.0.1", port }, () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) {
          console.warn(`[dev-electron] CDP port ${port} still busy after ${timeoutMs / 1000}s — launching anyway`);
          resolve();
        } else {
          setTimeout(check, 250);
        }
      });
      sock.on("error", () => {
        sock.destroy();
        resolve(); // connection refused → port is free
      });
    };
    check();
  });
}

// Mirror of resolveCanonicalForwardTarget() in lib/dev/worktree-bootstrap.ts —
// kept in plain JS so a canonical boot needn't spawn tsx just to decide. When
// THIS checkout is the canonical repo and EXACTLY ONE registered worktree
// `Libi Electron (<key>)` config still exists on disk, return it so a generic
// `preview_start("Libi Electron")` forwards to that worktree instead of silently
// booting canonical (main) code. 0 → boot canonical; 2+ → boot canonical + warn.
function resolveForwardTarget(root) {
  const WORKTREE_CONFIG_KEY = "libiWorktree"; // == lib/dev/worktree-bootstrap.ts
  const devElectronRel = path.join("scripts", "dev-electron.js");
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(root, ".claude", "launch.json"), "utf-8"),
    );
    if (!Array.isArray(cfg.configurations)) return null;
    const targets = [];
    for (const c of cfg.configurations) {
      const key = c && c[WORKTREE_CONFIG_KEY];
      const args = c && c.runtimeArgs;
      const arg0 = Array.isArray(args) ? args[0] : null;
      if (typeof key !== "string" || typeof arg0 !== "string") continue;
      if (!arg0.endsWith(devElectronRel)) continue;
      const wtPath = path.dirname(path.dirname(arg0));
      if (path.resolve(wtPath) === path.resolve(root)) continue;
      if (!fs.existsSync(arg0)) continue;
      targets.push({ key, scriptPath: arg0 });
    }
    if (targets.length === 1) return targets[0];
    if (targets.length > 1) {
      console.warn(
        `[dev-electron] ${targets.length} worktrees registered — not auto-forwarding. ` +
          `Use preview_start with one of: ` +
          targets.map((t) => `"Libi Electron (${t.key})"`).join(", "),
      );
    }
    return null;
  } catch {
    return null;
  }
}

// CDP bridge for worktrees: expose the worktree's Electron CDP on the canonical
// base port (9222) too, so a `@playwright/mcp` (electron-playwright) MCP spawned
// against the CANONICAL `.mcp.json` (which points at 9222) can drive THIS
// worktree's Electron. Best-effort: skipped if 9222 is already taken (canonical
// Electron running). Returns the server (close on shutdown) or null.
const CANONICAL_CDP_BASE = 9222; // == CDP_PORT_BASE in lib/dev/worktree-bootstrap.ts
function startCdpBridge(fromPort, toPort) {
  const net = require("node:net");
  const server = net.createServer((c) => {
    const upstream = net.connect(toPort, "127.0.0.1");
    c.on("error", () => upstream.destroy());
    upstream.on("error", () => c.destroy());
    c.pipe(upstream);
    upstream.pipe(c);
  });
  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.warn(
        `[dev-electron] CDP bridge ${fromPort}→${toPort} skipped — port ${fromPort} already in use`,
      );
    } else {
      console.warn(`[dev-electron] CDP bridge error: ${err && err.message}`);
    }
  });
  server.listen(fromPort, "127.0.0.1", () => {
    console.log(
      `[dev-electron] CDP bridge ${fromPort}→${toPort} up — canonical electron-playwright can drive this worktree`,
    );
  });
  return server;
}

(async () => {
  // Self-heal native-module ABI + electron binary BEFORE anything else.
  // .claude/launch.json runs this script directly (no npm pre-hooks), so
  // relying on predev:electron alone leaves that path broken after every
  // `npm install` (postinstall rebuilds native deps for Electron's ABI).
  for (const script of ["ensure-native-modules.js", "ensure-electron-binary.js"]) {
    try {
      execFileSync(process.execPath, [path.join(__dirname, script)], {
        stdio: "inherit",
      });
    } catch {
      console.error(`[dev-electron] ${script} failed — cannot continue`);
      process.exit(1);
    }
  }

  // Forward a canonical-checkout boot to the single active worktree (so a
  // generic preview_start never silently runs main code) — see resolveForwardTarget.
  const forward = resolveForwardTarget(ROOT);
  if (forward) {
    console.log(
      `[dev-electron] active worktree '${forward.key}' → forwarding to ${forward.scriptPath}`,
    );
    durableLog(`forwarding to worktree ${forward.key}: ${forward.scriptPath}`);
    const child = spawn(process.execPath, [forward.scriptPath], {
      stdio: "inherit",
      cwd: path.dirname(path.dirname(forward.scriptPath)),
      env: process.env,
      detached: true,
    });
    const relay = (sig) => {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          process.kill(child.pid, sig);
        } catch {
          /* gone */
        }
      }
    };
    process.on("SIGINT", () => relay("SIGTERM"));
    process.on("SIGTERM", () => relay("SIGTERM"));
    child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    return;
  }

  ensureCompiled();
  const { env, port, cdpPort } = await resolveEnv();
  console.log(
    `[dev-electron] LIBI_PORT=${port}  LIBI_CDP_PORT=${cdpPort}  LIBI_HOME=${env.LIBI_HOME ?? "(default ~/.libi)"}`,
  );

  // We invoke bin/libi.js directly so the bootstrap inside it is a
  // cheap no-op (env already populated) but Category A still runs.
  //
  // `detached: true` makes `next` its own process-GROUP leader. bin/libi.js
  // spawns a deep descendant tree — `npx next dev` → a `next-server` worker
  // that binds the port, plus the libi server warms `claude` agent procs. A
  // plain `child.kill()` signals only the DIRECT child, so the grandchildren
  // reparent to launchd and keep the port bound. Signalling the whole group
  // (`process.kill(-pid)`) reaps them all — none of the intermediates call
  // setsid, so they share the leader's group. We do NOT unref(): the launcher
  // stays bound to its children for the dev session.
  const next = spawn(
    process.execPath,
    [path.join(ROOT, "bin", "libi.js"), "--port", String(port)],
    { stdio: "inherit", cwd: ROOT, env, detached: true },
  );

  let electronChild = null;
  let cdpBridge = null;
  let shuttingDown = false;

  // Signal an entire process group by negative pid, falling back to the bare
  // pid if the group is already gone (ESRCH) or the detached spawn somehow
  // didn't take. Best-effort — never throws.
  const signalGroup = (child, sig) => {
    if (!child || child.pid == null) return;
    try {
      process.kill(-child.pid, sig); // negative pid → whole group
    } catch (err) {
      if (err && err.code === "ESRCH") return; // already dead
      try {
        process.kill(child.pid, sig);
      } catch {
        /* gone */
      }
    }
  };

  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Graceful SIGTERM to each child's whole group…
    if (cdpBridge) {
      try {
        cdpBridge.close();
      } catch {
        /* already closed */
      }
    }
    signalGroup(electronChild, "SIGTERM");
    signalGroup(next, "SIGTERM");
    // …then an escalation reaper: anything that ignored / was slow on SIGTERM
    // gets SIGKILLed so the port is never left bound by a half-dead
    // next-server. The timer is unref'd so it can't keep us alive on its own.
    setTimeout(() => {
      signalGroup(electronChild, "SIGKILL");
      signalGroup(next, "SIGKILL");
      process.exit(code);
    }, 2000).unref();
  };
  process.on("SIGINT", () => {
    durableLog(`received SIGINT → shutdown — ${describeParent()}`);
    shutdown(0);
  });
  process.on("SIGTERM", () => {
    durableLog(
      `received SIGTERM → shutdown (parent/launcher killed us) — ${describeParent()}`,
    );
    shutdown(0);
  });
  next.on("exit", (code, signal) => {
    const msg = `next exited (code ${code}${signal ? `, signal ${signal}` : ""})`;
    console.log(`[dev-electron] ${msg}`);
    durableLog(msg);
    shutdown(code ?? 0);
  });

  try {
    console.log(`[dev-electron] Waiting for http://127.0.0.1:${port} …`);
    await waitForServer({
      port,
      // Category A logs here continuously while installing deps — treat
      // recent writes as "boot in progress" and keep waiting.
      activityFile: path.join(
        env.LIBI_HOME || path.join(os.homedir(), ".libi"),
        "logs",
        "libi.log",
      ),
      onExtend: () => {
        console.log(
          "[dev-electron] Server not up yet but boot activity detected (first-run installs?) — still waiting…",
        );
      },
    });
    console.log("[dev-electron] Server ready — launching Electron");
  } catch (err) {
    console.error("[dev-electron]", err.message);
    shutdown(1);
    return;
  }

  // Ensure the CDP port is free before launching — a just-killed Electron
  // releases it a beat late, and racing onto an occupied port SIGTRAPs.
  if (process.env.LIBI_CDP !== "0") {
    await waitForPortFree(cdpPort);
  }

  const ELECTRON_BIN = path.join(ROOT, "node_modules", ".bin", "electron");
  // detached: own process group, so SIGTERM/SIGKILL to -electronChild.pid
  // reaps Electron's main + renderer/GPU helper subprocesses together.
  electronChild = spawn(ELECTRON_BIN, [MAIN], {
    stdio: "inherit",
    cwd: ROOT,
    env,
    detached: true,
  });
  electronChild.on("exit", (code, signal) => {
    const msg = `electron exited (code ${code}${signal ? `, signal ${signal}` : ""})`;
    console.log(`[dev-electron] ${msg}`);
    durableLog(msg);
    shutdown(code ?? 0);
  });

  // Bridge canonical CDP base (9222) → this worktree's CDP port, so an
  // electron-playwright MCP bound to the canonical .mcp.json can drive us.
  // Gated to worktrees (cdpPort != 9222) and skippable via LIBI_CDP=0.
  if (
    process.env.LIBI_CDP !== "0" &&
    typeof cdpPort === "number" &&
    cdpPort !== CANONICAL_CDP_BASE
  ) {
    cdpBridge = startCdpBridge(CANONICAL_CDP_BASE, cdpPort);
  }
})();
