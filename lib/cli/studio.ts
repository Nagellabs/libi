import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { runInstallPhase } from "@/lib/server/lifecycle";
import { cliAdapter } from "@/lib/server/lifecycle/adapters/cli";
import { inDevCheckout } from "@/lib/dev/worktree-bootstrap";
import { setRelaunchHandler } from "@/lib/server/lifecycle/relaunch";
import { ensureNextExternalSymlinks } from "@/lib/install/next-externals";
import { findPackageRoot } from "@/lib/runtime/package-root";
import { maybePrintUpdateNotice } from "@/lib/cli/update-notice";

/** Walk up from `dir` looking for a `.git` entry — true if inside a git repo. */
function isInsideGitRepo(dir: string): boolean {
  let cur = path.resolve(dir);
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(cur, ".git"))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return false;
}

/** Resolve the effective port for `next dev`. When the CLI default
 *  ("3456") is in effect AND `LIBI_PORT` is set in the env, prefer the
 *  env. Otherwise the CLI value wins. This belt-and-suspenders the
 *  worktree-bootstrap's `--port` injection: someone running
 *  `node bin/libi.js` outside the bootstrap (rare) but with
 *  `LIBI_PORT=3470` exported still gets the right port. */
export function resolvePort(
  cliPort: string,
  env: NodeJS.ProcessEnv,
): string {
  if (cliPort !== "3456") return cliPort;
  const envPort = env.LIBI_PORT;
  if (!envPort) return cliPort;
  const n = Number.parseInt(envPort, 10);
  if (!Number.isFinite(n)) return cliPort;
  return String(n);
}

/** Resolve the external agent dir for `--connect-agent`.
 *  - flag absent → null (normal mode)
 *  - bare flag   → the caller's launch cwd (LIBI_LAUNCH_CWD — bin/libi.js
 *    chdirs to the checkout root, so process.cwd() is only a fallback)
 *  - explicit dir → resolved absolute against the launch cwd */
export function resolveConnectAgentDir(
  flagValue: string | boolean | undefined,
  env: Record<string, string | undefined>,
): string | null {
  if (!flagValue) return null;
  const base = env.LIBI_LAUNCH_CWD || process.cwd();
  if (flagValue === true) return base;
  return path.resolve(base, flagValue);
}

/**
 * Boot Next.js in production mode, in-process — mirrors electron/main.ts's
 * `startNextServer()` (same programmatic `next({ dev: false })` +
 * `http.createServer` custom-server pattern), except bound to the CLI's
 * requested port instead of an ephemeral one. Requires a pre-built `.next`
 * (shipped in the npm tarball — see package.json's `files`); `next()` throws
 * its own actionable "Could not find a production build" error when it's
 * missing, so this doesn't duplicate that message.
 *
 * `dir` is a project root, not the current working directory — a real
 * `npx libi`/`node_modules/.bin/libi` launch runs from wherever the user
 * happened to invoke the command, which is almost never this package's own
 * directory (see `lib/install/npm-root.ts#npmResolveAnchors` for the same
 * cwd-hijack pitfall in a different resolver).
 */
async function runProductionServer(port: string, dir: string): Promise<void> {
  process.env.PORT = port;

  // The `process.chdir()` fix for cwd-relative on-disk resolution (found via
  // `lib/db/client.ts#getMigrationsFolder()` — `path.join(cwd(),
  // "drizzle/sqlite")`, which silently failed DB migration with "Can't find
  // meta/_journal.json file") no longer lives here. It has to run BEFORE
  // `runInstallPhase` (Category A) in `startStudio`, not just before this
  // function — `mcp/registry/installers.ts#resolvePlaywrightCoreCli` and
  // other Category A installers also resolve cwd-relative paths, and Category
  // A runs first. Chdir'ing only here (post-install-phase) left every
  // cwd-relative resolution in Category A still broken on a fresh machine.
  // See `startStudio` for the actual chdir call.

  // `npm pack`/`npm publish` strip every symlink from the tarball, so a
  // freshly-installed copy of `.next/node_modules` (Turbopack's externals
  // symlink farm — see next.config.ts's `serverExternalPackages` comment)
  // arrives empty. Restore it from the build-time manifest before Next
  // reads anything — see lib/install/next-externals.ts for the full story.
  //
  // Deliberately NOT wrapped in a try/catch: every condition this can throw
  // on (manifest missing, manifest stale, package unresolvable) otherwise
  // yields a server that binds its port and returns 500 for every route —
  // the one failure shape a user cannot distinguish from an app bug. The
  // caller (`startStudio`) prints the message and exits 1.
  ensureNextExternalSymlinks(path.join(dir, ".next"));

  // Dynamic import: this module is imported unconditionally by
  // lib/cli/index.ts for every subcommand (serve-mcp, update, …), so a
  // static top-level `import next from "next"` would pull the whole Next
  // module graph into every CLI invocation. Load it only when actually
  // booting the production server.
  const { default: next } = await import("next");
  const nextApp = next({ dev: false, dir });
  const handle = nextApp.getRequestHandler();
  await nextApp.prepare();
  const server = createServer((req, res) => handle(req, res));

  // Loopback by default. A bare listen(port, cb) binds 0.0.0.0, which serves
  // the studio — including every GET route — to anyone on the same network.
  // The request guard does NOT cover that: it exempts safe methods before
  // its loopback-host check. LIBI_HOST exists for the rare deliberate case
  // (a VM, a container); it is never the default.
  // `||`, not `??`: an empty LIBI_HOST="" would pass `??` and Node binds "" to `::`.
  const host = process.env.LIBI_HOST || "127.0.0.1";

  // Mirror the dev path's "server requested a restart" UX (exit code 75 —
  // see lib/server/lifecycle/relaunch.ts). In dev mode that's a SEPARATE
  // child process, so the parent below observes it via `child.on("exit")`;
  // here Category B's relaunch request runs inside THIS process, so we
  // register our own handler instead of falling through to relaunch.ts's
  // silent `process.exit(75)` fallback.
  setRelaunchHandler(() => {
    process.stdout.write(
      "[libi] Server requested restart. Press Ctrl+C and re-run `npx @nagellabs/libi`.\n",
    );
    process.exit(75);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port), host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function startStudio(
  port: string,
  connectAgent?: string | boolean,
  opts: { dirname?: string } = {},
): Promise<void> {
  port = resolvePort(port, process.env);
  const connectedAgentDir = resolveConnectAgentDir(connectAgent, process.env);
  if (connectedAgentDir) {
    process.env.LIBI_CONNECT_AGENT_DIR = connectedAgentDir;
  }

  // Dev-checkout detection + the production chdir fix both anchor on THIS
  // MODULE's own location (`__dirname`, injectable via `opts.dirname` for
  // tests) — not `process.cwd()` or `LIBI_LAUNCH_CWD`: a real `npx libi` runs
  // from wherever the user typed the command, which could itself be inside an
  // unrelated git repo (their own project) — cwd-anchoring would misdetect
  // that as "dev checkout". `.git` is never present in a published npm
  // tarball (npm always excludes it), so this reliably distinguishes the two
  // cases.
  //
  // The chdir MUST happen here, before `runInstallPhase` (Category A) below —
  // not merely before the production Next.js boot. Several Category A
  // installers (e.g. `mcp/registry/installers.ts#resolvePlaywrightCoreCli`,
  // reached by the tier-1 `playwright-chromium` installer's `verify()` on any
  // machine that doesn't already have Chromium in playwright's shared browser
  // cache) resolve on-disk paths relative to `process.cwd()`, which for a
  // real `npx libi` launch is wherever the user typed the command — not this
  // package's own directory. Chdir'ing only later (inside
  // `runProductionServer`, as this used to) left Category A running against
  // the wrong cwd and exiting 1 before the server ever started on a fresh
  // machine. `resolveConnectAgentDir` above already captured its answer from
  // `LIBI_LAUNCH_CWD`/the ORIGINAL cwd, so reordering the chdir to run after
  // it (but before Category A) is safe for `--connect-agent`.
  //
  // The dev branch (spawning `next dev`) deliberately does NOT chdir here —
  // it keeps spawning with `cwd: process.cwd()` unchanged, exactly as before.
  const dirname = opts.dirname ?? __dirname;
  const isDevCheckout = inDevCheckout(dirname);
  // Walk up to the nearest package.json rather than hardcoding `../..`: this
  // module runs from `lib/cli/` in dev and from the compiled mirror at
  // `dist-cli/lib/cli/` for an npm install (scripts/build-cli.js), one level
  // deeper. A fixed hop count chdirs the production server into `dist-cli/`
  // there — where there is no `.next` — so Next boots against nothing. The
  // `../..` stays as the fallback for a bundled runtime whose `__dirname` is a
  // build-time placeholder that doesn't exist on disk.
  const projectRoot = findPackageRoot(dirname) ?? path.resolve(dirname, "..", "..");
  if (!isDevCheckout) {
    try {
      process.chdir(projectRoot);
    } catch {
      /* best-effort — runInstallPhase / next() will surface its own error
       * if `projectRoot` is unusable. */
    }
  }

  const result = await runInstallPhase({ adapter: cliAdapter() });
  if (!result.ok) {
    process.exit(1);
  }

  if (!connectedAgentDir) {
    process.stdout.write(
      `[libi] Starting server on port ${port}…\n[libi] Open http://localhost:${port}\n`,
    );
  } else {
    process.stdout.write(
      `[libi] Server running on port ${port} (connect-agent mode)\n[libi] Agent config synced to ${connectedAgentDir} — launch your coding agent there.\n`,
    );
    const inGit = isInsideGitRepo(connectedAgentDir);
    const banner = inGit
      ? "⚠  WARNING — this directory is inside a GIT REPOSITORY."
      : "⚠  Note — connect-agent wrote agent config into this directory.";
    process.stdout.write(
      `[libi] ${banner}\n` +
        `[libi]    .mcp.json and .claude/settings.local.json reference your API keys and agent config.\n` +
        `[libi]    They are secret-free (env-var references, not literal keys) and added to .gitignore automatically.\n` +
        `[libi]    Do NOT commit them — export the referenced keys (e.g. FAL_KEY) in the shell that runs your CLI.\n`,
    );
  }

  // Installed runs (global npm / npx) get a one-line update notice when a
  // newer version is published. Fire-and-forget: it prints whenever the
  // registry answers (or never, silently), and must not delay the server.
  // Skipped for a dev checkout, whose version is meaningless vs the registry.
  if (!isDevCheckout) {
    void maybePrintUpdateNotice();
  }

  // `next dev` (Turbopack, live reload) only for a real dev checkout — see
  // `isDevCheckout`/`projectRoot`, resolved once above (before Category A)
  // and reused here so the boot-mode decision can't disagree with itself.
  if (!isDevCheckout) {
    try {
      await runProductionServer(port, projectRoot);
    } catch (err) {
      process.stderr.write(
        `[libi] Failed to start the server: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
    return;
  }

  // Loopback by default — see the matching comment in `runProductionServer`.
  // Resolved locally rather than threaded through as a parameter: this
  // branch and `runProductionServer` are separate functions with no shared
  // scope for it.
  // `||`, not `??`: an empty LIBI_HOST="" would pass `??` and Node binds "" to `::`.
  const host = process.env.LIBI_HOST || "127.0.0.1";
  const child = spawn("npx", ["next", "dev", "--port", port, "-H", host], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: port,
      ...(connectedAgentDir ? { LIBI_CONNECT_AGENT_DIR: connectedAgentDir } : {}),
    },
  });
  child.on("exit", (code) => {
    if (code === 75) {
      process.stdout.write(
        "[libi] Server requested restart. Press Ctrl+C and re-run `npx @nagellabs/libi`.\n",
      );
    }
    process.exit(code ?? 0);
  });
}
