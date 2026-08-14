import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { serverLogger as logger } from "@/lib/logger";
import { buildSpawnEnv } from "@/mcp/registry/spawn-env";

/**
 * Shared primitives for managing an npm "install root" — a directory holding
 * a generated `package.json` plus its `node_modules/`.
 *
 * libi has TWO such roots, deliberately kept separate because `npm install` is
 * all-or-nothing per root:
 *   - `~/.libi`         — bundled MCP packages (`lib/mcp/bundled-install.ts`)
 *   - `~/.libi/agents`  — runtime agent packages (`lib/agents/runtime-install.ts`)
 *
 * Sharing one root would mean a single failing package (e.g. a yanked Claude
 * ACP adapter) marks EVERY bundled MCP as failed, so a Codex-only user pays for
 * a Claude-only outage. Both roots run the same install mechanics — that's what
 * lives here, so there is exactly one npm runner, one cross-process lock, and
 * one version-drift check in the codebase.
 */

const execFileAsync = promisify(execFile);

export const DEFAULT_LOCK_FILE = ".bundled-install.lock";
const LOCK_POLL_MS = 200;

/**
 * npm timeout `lockTimingForNpmTimeout` derives from when a caller doesn't
 * pass its own `staleMs`/`timeoutMs`. Matches the bundled-MCP root's npm
 * timeout (`NPM_INSTALL_TIMEOUT_MS` in `lib/mcp/bundled-install.ts`), so
 * that root's lock behaviour (10 min stale / 10 min acquire-timeout) is
 * unchanged by this module gaining per-root lock timing.
 */
const DEFAULT_LOCK_NPM_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Grace period added on top of a root's npm install timeout before its lock
 * is considered abandoned. Must stay > 0 — see `lockTimingForNpmTimeout`.
 */
const LOCK_STALE_MARGIN_MS = 5 * 60 * 1000;

/**
 * Derive a root's lock staleness + lock-acquisition timeout from the npm
 * install timeout it protects.
 *
 * INVARIANT (must hold for every root): `npmTimeoutMs < staleMs <= timeoutMs`.
 * If a lock can go stale before the npm install it's guarding would even
 * have timed out on its own, a second process can judge an in-progress
 * install's lock "stale", steal it, and start a COLLIDING second
 * `npm install` into the same `node_modules` — interleaved staging renames,
 * ENOTEMPTY, a half-written package.
 *
 * This is derived from `npmTimeoutMs` instead of two independently
 * hand-maintained constants on purpose: before the agent-package root
 * existed, `npmTimeout(5m) < lockStale(10m)` held because there was only
 * one npm timeout in the codebase. Giving the agent root its own 30-min npm
 * timeout while `LOCK_STALE_MS`/`LOCK_TIMEOUT_MS` stayed hardcoded at 10 min
 * broke that invariant silently — a 14-min real install could get its lock
 * stolen by a second process at the 10-min mark. Deriving staleMs/timeoutMs
 * from npmTimeoutMs makes that impossible by construction: raising a root's
 * npm timeout automatically raises its lock timing along with it.
 */
export function lockTimingForNpmTimeout(npmTimeoutMs: number): {
  staleMs: number;
  timeoutMs: number;
} {
  const staleMs = npmTimeoutMs + LOCK_STALE_MARGIN_MS;
  return { staleMs, timeoutMs: staleMs };
}

/** Common shape every managed install source reduces to. */
export interface NpmInstallEntry {
  id: string;
  name: string;
  npmPackage: string;
  pinnedVersion: string;
}

/** Version of `<root>/node_modules/<pkg>` on disk, or null if not installed. */
export function readInstalledVersion(root: string, npmPackage: string): string | null {
  const pkgPath = path.join(root, "node_modules", ...npmPackage.split("/"), "package.json");
  try {
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export interface WritePackageJsonOptions {
  /** `name` field of the generated manifest. */
  name: string;
  /** `description` field — say which module generates it. */
  description: string;
}

/** Generate `<root>/package.json` pinning every managed entry exactly. */
export function writePackageJson(
  root: string,
  managed: NpmInstallEntry[],
  options: WritePackageJsonOptions,
): void {
  const dependencies: Record<string, string> = {};
  for (const def of managed) {
    dependencies[def.npmPackage] = def.pinnedVersion;
  }
  const pkgJson = {
    name: options.name,
    private: true,
    version: "0.0.0",
    description: options.description,
    dependencies,
  };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");
}

/**
 * Directories to anchor a runtime `createRequire` at when resolving packages
 * that must come from libi's OWN `node_modules`, best candidate first.
 *
 * `__dirname` leads. `electron/main.ts` chdirs to `<app>/` (the packaged
 * `Resources/app`, holding `node_modules/`), but `bin/libi.js` chdirs to the
 * checkout root ONLY in a dev checkout (`inDevCheckout()`) — for a real
 * `npx libi` install the cwd is whatever directory the user happened to run
 * the command from. If that directory contains an unrelated `node_modules/npm`
 * (e.g. the user ran `npx libi` from inside another npm project), anchoring on
 * cwd first would silently resolve THAT npm instead of libi's vendored, pinned
 * one — exactly what this module exists to avoid. `__dirname` always points at
 * `lib/install/` inside libi's own tree in every non-bundled runtime, so it is
 * the anchor that is actually safe to try first.
 *
 * In a BUNDLED build `__dirname` is Turbopack's build-time placeholder
 * `"/ROOT/lib/install"`, which does not exist at runtime — that candidate
 * fails its `existsSync` check in `resolveVendoredNpmCli` and falls through to
 * `cwd`, which IS the app root there (both entry points normalise it before
 * this runs). So packaged behaviour is unchanged by this ordering; only the
 * dev/`npx libi` cwd-hijack case is fixed.
 *
 * `cwd` therefore stays second — the fallback for bundled runtimes only. It
 * costs one failed resolve in dev/CLI mode and shows up in the thrown
 * diagnostic, which is strictly better than having no second candidate at all.
 *
 * Exported for tests: the ordering is the contract, and a silent reordering
 * would resolve npm out of whatever directory the user happened to launch from.
 */
export function npmResolveAnchors(cwd: string = process.cwd()): string[] {
  const anchors = [__dirname, cwd];
  return anchors.filter((a, i): a is string => typeof a === "string" && a.length > 0 && anchors.indexOf(a) === i);
}

/**
 * Resolve the vendored npm CLI entry point. We ship `npm` as a direct
 * dependency so libi never needs to find a system / Homebrew / nvm
 * install. In a packaged Electron .app it lives at
 * `Resources/app/node_modules/npm/bin/npm-cli.js`; in dev it lives at
 * `<repo>/node_modules/npm/bin/npm-cli.js`.
 *
 * The npm package's `exports` field blocks resolving `npm/bin/…` directly, so
 * we resolve its `package.json` (always exported) and walk to `bin/npm-cli.js`.
 *
 * WHY A RUNTIME `createRequire` AND NOT A BARE `require.resolve`:
 * a statically visible `require.resolve("npm/package.json")` is not a
 * filesystem lookup after bundling — Turbopack BUNDLES the target and rewrites
 * the call to the module's numeric id. The emitted production code was
 * literally `path.join(path.dirname(467884), "bin", "npm-cli.js")`, so this
 * function threw `TypeError: The "path" argument must be of type string.
 * Received type number (467884)` in EVERY bundled build — packaged Electron
 * and `npx libi` alike. It went unnoticed because `getManagedBundledNpmMcps()`
 * returns `[]` today, so no bundled build had ever reached `runNpmInstall`;
 * the runtime Claude-adapter install is the first caller that does.
 *
 * `createRequire` produces a REAL Node require that the bundler cannot see
 * through, so resolution happens on disk at runtime, where it belongs. Each
 * candidate is confirmed with an existence check so a wrong anchor fails loudly
 * here instead of handing a nonexistent path to the spawn.
 */
export function resolveVendoredNpmCli(): string {
  const tried: string[] = [];
  for (const anchor of npmResolveAnchors()) {
    let cli: string;
    try {
      const requireFrom = createRequire(path.join(anchor, "noop.js"));
      cli = path.join(path.dirname(requireFrom.resolve("npm/package.json")), "bin", "npm-cli.js");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tried.push(`${anchor} (npm not resolvable: ${message})`);
      continue;
    }
    if (fs.existsSync(cli)) return cli;
    tried.push(`${cli} (missing)`);
  }
  throw new Error(`Could not locate the vendored npm CLI. Tried: ${tried.join("; ")}`);
}

export interface RunNpmInstallOptions {
  /**
   * Hard timeout for the npm child process. Sized per-root: small MCP packages
   * install in seconds, while the Claude ACP adapter drags a ~212MB platform
   * binary behind it and needs a much longer ceiling on a slow connection.
   */
  timeoutMs: number;
  /** Logger `tag` so each root's installs are filterable independently. */
  logTag: string;
}

/**
 * Max bytes of child stdout/stderr retained for logging. Mirrors the NUMBER
 * `execFile`'s `maxBuffer` has always used, not its behaviour: `execFile`
 * KILLS the child with ENOBUFS the moment either stream exceeds this many
 * bytes, whereas here we simply stop appending to the retained buffer and let
 * npm keep running to completion — a large-but-harmless amount of npm log
 * chatter can no longer abort an otherwise-successful install.
 */
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

/**
 * npm CLI arguments, identical on both runners.
 *
 * `--ignore-scripts` blocks lifecycle scripts (pre/postinstall) of the
 * installed packages AND their transitive dependencies from running arbitrary
 * code at install time — the primary supply-chain RCE vector (RC-E). No
 * bundled MCP package requires lifecycle scripts to function, so this applies
 * to everything; add a per-package exemption here only if a future bundled
 * package is verified to need them.
 *
 * Extracted so the two runners below can never drift apart in what they
 * actually ask npm to do, and so a unit test can assert the flag set without
 * spawning anything.
 */
export function npmInstallArgs(root: string): string[] {
  return ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", "--prefix", root];
}

/** Mechanism used to execute the vendored npm CLI. */
export type NpmRunner = "execfile-node" | "electron-utility-process";

/**
 * Pick how to run npm, branching on the RUNTIME rather than on how libi was
 * packaged.
 *
 * Under plain Node (`npx libi`, the CLI, tests) `process.execPath` IS a real
 * `node`, so `execFile(process.execPath, [npmCli, …])` runs npm directly.
 * That path is unchanged and must stay that way.
 *
 * Under Electron it is NOT. `process.execPath` is the Libi binary, and the
 * historical trick of setting `ELECTRON_RUN_AS_NODE=1` to flip it into Node
 * mode is dead: `electron-builder.yml` sets the security fuse
 * `electronFuses.runAsNode: false`, which makes Electron IGNORE that variable
 * entirely. The spawn therefore launched a SECOND Libi GUI instance instead of
 * npm, and the install hung until its timeout (30 min for the agent root).
 *
 * This stayed invisible for a long time because `getManagedBundledNpmMcps()`
 * returns `[]` today — no bundled MCP is tier-1 — so `runNpmInstall` had never
 * actually executed inside a packaged app. The runtime Claude-adapter install
 * is the first code to need npm at runtime, which activated the latent bug.
 *
 * The fix keeps the fuse (it is a real hardening measure) and instead uses
 * Electron's `utilityProcess.fork()`, which spawns a genuine Node.js child
 * without depending on `ELECTRON_RUN_AS_NODE` at all.
 *
 * `versions` is injectable purely so this decision is unit-testable without an
 * Electron process.
 */
export function selectNpmRunner(
  versions: { electron?: string } = process.versions,
): NpmRunner {
  return versions.electron ? "electron-utility-process" : "execfile-node";
}

interface NpmFailureExtras {
  /** Human-readable cause appended to the `Command failed:` prefix. */
  reason: string;
  code?: number;
  killed?: boolean;
  signal?: string;
}

/**
 * Build a rejection that matches `execFileAsync`'s shape — same
 * `Command failed: …` message prefix, same `code`/`killed`/`signal`/`stdout`/
 * `stderr` properties — so callers (`lib/mcp/bundled-install.ts`,
 * `lib/agents/runtime-install.ts`), which stringify `err.message`, behave
 * identically no matter which runner produced the failure.
 */
function npmFailure(
  npmCli: string,
  args: string[],
  stdout: string,
  stderr: string,
  extras: NpmFailureExtras,
): Error {
  const err = new Error(
    `Command failed: ${npmCli} ${args.join(" ")} — ${extras.reason}\n${stderr}`,
  ) as Error & {
    code?: number;
    killed?: boolean;
    signal?: string;
    stdout?: string;
    stderr?: string;
  };
  if (extras.code !== undefined) err.code = extras.code;
  if (extras.killed !== undefined) err.killed = extras.killed;
  if (extras.signal !== undefined) err.signal = extras.signal;
  err.stdout = stdout;
  err.stderr = stderr;
  return err;
}

/**
 * Minimal shape of an Electron `UtilityProcess` this module depends on,
 * narrowed to what `runNpmViaUtilityProcess` actually touches. Exported so
 * tests can inject a fake child without pulling in the `electron` package
 * (which does not exist under plain Node — see the require-guard comment on
 * `forkViaElectronUtilityProcess` below).
 */
export interface UtilityProcessLike {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(): boolean;
  on(event: "exit", listener: (code: number) => void): unknown;
  // Signature matches Electron's real `UtilityProcess#on('error', …)`: a
  // non-continuable V8 fault, NOT a Node `Error` object. See the docblock on
  // the `"error"` handler below for why this three-arg shape matters.
  on(event: "error", listener: (type: "FatalError", location: string, report: string) => void): unknown;
}

/** Fork signature `runNpmViaUtilityProcess` depends on — injectable for tests. */
export type UtilityProcessForkFn = (
  modulePath: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdio: "pipe" },
) => UtilityProcessLike;

/**
 * Default `fork` implementation: Electron's real `utilityProcess.fork`.
 *
 * GUARDED, LAZY, RUNTIME require of `electron` — deliberate on all three
 * counts. Please do not "fix" this into a static import.
 *
 * GUARDED + LAZY: CLAUDE.md's "Code Style" rule forbids `require()`/dynamic
 * imports used to shave bundle size. This is a different thing — a runtime
 * AVAILABILITY guard. `electron` is a devDependency and simply DOES NOT EXIST
 * when libi runs under plain Node: `npx libi`, the CLI, and every unit test.
 * A static `import { utilityProcess } from "electron"` is evaluated at module
 * load, so it would crash all of those paths, none of which ever call this
 * function. Loading it here — behind `selectNpmRunner`'s
 * `process.versions.electron` check — means only a genuine Electron main
 * process ever touches it.
 *
 * RUNTIME (`createRequire`, not a bare `require`): a bundler-visible
 * specifier is not left alone. Turbopack rewrites `require("electron")` to
 * `require("electron-54412a2dc9f83256")` — a hashed alias that does not exist
 * at runtime — and adding `electron` to `serverExternalPackages` instead
 * breaks `build:electron` outright (see the note in next.config.ts). A
 * `createRequire` require is opaque to the bundler and reaches the real Node
 * loader, where Electron's `Module._load` hook returns the built-in main
 * process API. The anchor is irrelevant for a built-in like this — it is
 * intercepted before any path resolution — but reusing the same anchor list
 * keeps one mechanism in this file.
 */
const forkViaElectronUtilityProcess: UtilityProcessForkFn = (modulePath, args, options) => {
  const { utilityProcess } = createRequire(
    path.join(npmResolveAnchors()[0], "noop.js"),
  )("electron") as typeof import("electron");
  return utilityProcess.fork(modulePath, args, options) as unknown as UtilityProcessLike;
};

/**
 * Run npm as a real Node.js child of the Electron main process.
 *
 * ⚠️ ONLY FOR CLIs THAT CALL `process.exit()` THEMSELVES. npm does; most small
 * CLIs do not. An Electron `utilityProcess` child's event loop is held open by
 * the parent↔child MessagePort, so a program that merely runs to the end of
 * its script never exits and this function hangs until `timeoutMs` — reporting
 * a timeout for work that actually SUCCEEDED. Measured with a two-child
 * harness under Electron 36.9.5: a child calling `process.exit(0)` exited in
 * 61ms; an identical child without it was still alive at the 8s kill. The
 * child cannot release the handle itself either — `process.parentPort.close`
 * is not a function in this Electron.
 *
 * `prebuild-install` was the first caller to hit this
 * (`lib/runtime/runtime-install.ts#fetchElectronPrebuild`, discovered the
 * first time that code ran inside the packaged app). For any non-npm Node
 * program, spawn a REAL node via `resolveNodeCommand()`
 * (`lib/runtime/node-runtime.ts`) instead of reaching for this.
 *
 * `utilityProcess` is only available in the MAIN process — which is where this
 * runs: `electron/main.ts` starts Next.js in-process via `next({dev:false, …})`
 * + `nextApp.prepare()` after `app.on("ready")`, so all server code (Category A
 * and the runtime agent install alike) executes on the Electron main thread.
 *
 * `fork` defaults to the real Electron `utilityProcess.fork` and is only ever
 * overridden by tests, which run under plain Node where the default can't be
 * exercised (Electron doesn't exist there).
 */
export async function runNpmViaUtilityProcess(
  npmCli: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
  fork: UtilityProcessForkFn = forkViaElectronUtilityProcess,
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = fork(npmCli, args, {
      cwd: opts.cwd,
      env: opts.env,
      // Required for `.stdout` / `.stderr` to exist at all — without it the
      // child's output is inherited and we lose the logging the execFile path
      // has always produced.
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    const append = (buf: string, chunk: Buffer): string =>
      buf.length >= MAX_CAPTURE_BYTES ? buf : buf + chunk.toString("utf-8");
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    // `utilityProcess` has no built-in `timeout` option the way `execFile`
    // does, so we own it. Kill, then reject IMMEDIATELY rather than waiting on
    // `exit` — a child that ignores SIGTERM must not be able to hang the
    // install, which is the precise failure this whole change exists to remove.
    const timer = setTimeout(() => {
      child.kill();
      settle(() =>
        reject(
          npmFailure(npmCli, args, stdout, stderr, {
            reason: `timed out after ${opts.timeoutMs}ms`,
            killed: true,
            signal: "SIGTERM",
          }),
        ),
      );
    }, opts.timeoutMs);

    // Electron emits `'error'` on a non-continuable V8 fault (e.g. the npm
    // child OOMing while pulling the ~212MB adapter on a low-RAM machine).
    // With NO listener, an `'error'` event on any EventEmitter — including a
    // `UtilityProcess` — THROWS instead of being ignored, so the Electron
    // MAIN process takes an uncaught throw and the whole app disappears with
    // no diagnostic. This listener is what turns that into a clean rejection
    // instead. Electron's docs guarantee `'exit'` still follows `'error'`, so
    // `settle`'s guard (not `timer`/`resolve` reached twice) is what keeps
    // that second event from double-settling the promise.
    child.on("error", (type, location) => {
      settle(() =>
        reject(
          npmFailure(npmCli, args, stdout, stderr, {
            reason: `utilityProcess emitted a non-continuable '${type}' error at ${location}`,
          }),
        ),
      );
    });

    child.on("exit", (code: number) => {
      settle(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(
          npmFailure(npmCli, args, stdout, stderr, {
            reason: `exited with code ${code}`,
            code,
          }),
        );
      });
    });
  });
}

export async function runNpmInstall(root: string, options: RunNpmInstallOptions): Promise<void> {
  const start = Date.now();
  const npmCli = resolveVendoredNpmCli();
  const args = npmInstallArgs(root);
  const env = buildSpawnEnv();
  const runner = selectNpmRunner();

  logger.info(
    { tag: options.logTag, op: "npm_install_start", runner, root },
    `Running npm install via ${runner}`,
  );

  let stdout: string;
  let stderr: string;
  if (runner === "electron-utility-process") {
    ({ stdout, stderr } = await runNpmViaUtilityProcess(npmCli, args, {
      cwd: root,
      env,
      timeoutMs: options.timeoutMs,
    }));
  } else {
    // Plain Node: `process.execPath` is a real `node`, so the vendored npm CLI
    // runs directly. `ELECTRON_RUN_AS_NODE` is a harmless no-op here and is
    // retained so this path is byte-for-byte the behaviour it has always had.
    ({ stdout, stderr } = await execFileAsync(process.execPath, [npmCli, ...args], {
      cwd: root,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
      } as unknown as NodeJS.ProcessEnv,
      timeout: options.timeoutMs,
      maxBuffer: MAX_CAPTURE_BYTES,
    }));
  }

  logger.info(
    {
      tag: options.logTag,
      op: "npm_install_done",
      runner,
      durationMs: Date.now() - start,
      stdoutLen: stdout.length,
      stderrLen: stderr.length,
    },
    "npm install completed",
  );
}

export interface InstallLockOptions {
  /** Lock file name inside `root`. One per root so the two roots never block each other. */
  lockFile?: string;
  /** Logger `tag` for lock events — also threaded into the diagnostic messages below. */
  logTag?: string;
  /**
   * Ms before an unresponsive lock is considered abandoned and stolen.
   * Defaults to `lockTimingForNpmTimeout(DEFAULT_LOCK_NPM_TIMEOUT_MS).staleMs`
   * (10 min) — the bundled-MCP root's historical value. A root with its own
   * npm timeout should pass `lockTimingForNpmTimeout(thatTimeoutMs)` here
   * rather than a hand-picked number, so the invariant documented on
   * `lockTimingForNpmTimeout` holds.
   */
  staleMs?: number;
  /** Ms to keep polling for the lock before giving up entirely. Same default/guidance as `staleMs`. */
  timeoutMs?: number;
}

/**
 * Cross-process file lock for the npm install step. Two libi processes
 * commonly coexist — the CLI parent (`bin/libi.js`) and the Next.js child —
 * and both run their installs at boot. Without this lock they'd race the
 * same `npm install` against the same directory.
 *
 * Strategy: exclusive-create a lock file containing `{pid, startedAt}`.
 * If we can't create it, poll. If the holder is stale (PID gone or older
 * than `staleMs`), steal the lock. Hard timeout after `timeoutMs` to
 * prevent hangs. See `InstallLockOptions` for how these are chosen per root.
 */
export async function acquireInstallLock(
  root: string,
  options: InstallLockOptions = {},
): Promise<() => void> {
  const lockFile = options.lockFile ?? DEFAULT_LOCK_FILE;
  const tag = options.logTag ?? "bundled-install";
  const defaultTiming = lockTimingForNpmTimeout(DEFAULT_LOCK_NPM_TIMEOUT_MS);
  const staleMs = options.staleMs ?? defaultTiming.staleMs;
  const timeoutMs = options.timeoutMs ?? defaultTiming.timeoutMs;
  const lockPath = path.join(root, lockFile);
  const startWait = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      fs.closeSync(fd);
      logger.info({ tag, op: "lock_acquired", pid: process.pid }, `Acquired ${tag} lock`);
      return () => releaseInstallLock(lockPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") throw err;
    }

    if (isLockStale(lockPath, staleMs)) {
      logger.warn({ tag, op: "lock_stale_steal", lockPath }, `Stealing stale ${tag} lock`);
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
      continue;
    }

    if (Date.now() - startWait > timeoutMs) {
      throw new Error(`${tag} lock not released within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
}

export function releaseInstallLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* already gone — fine */
  }
}

export function isLockStale(
  lockPath: string,
  staleMs: number = lockTimingForNpmTimeout(DEFAULT_LOCK_NPM_TIMEOUT_MS).staleMs,
): boolean {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    const data = JSON.parse(raw) as { pid?: number; startedAt?: number };
    if (typeof data.startedAt === "number" && Date.now() - data.startedAt > staleMs) {
      return true;
    }
    if (typeof data.pid === "number") {
      try {
        // Signal 0 doesn't kill — just checks "is this PID alive?"
        process.kill(data.pid, 0);
        return false;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        // ESRCH = no such process → stale. EPERM = process exists but not ours → alive.
        return e.code === "ESRCH";
      }
    }
    return false;
  } catch {
    // Lock file unreadable / disappeared between checks — treat as stale so we retry.
    return true;
  }
}
