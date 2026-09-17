import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { runInstallPhase } from "@/lib/server/lifecycle";
import { cliAdapter } from "@/lib/server/lifecycle/adapters/cli";
import { inDevCheckout } from "@/lib/dev/worktree-bootstrap";
import { setRelaunchHandler } from "@/lib/server/lifecycle/relaunch";
import { ensureNextExternalSymlinks } from "@/lib/install/next-externals";
import { resolveNodeCommand } from "@/lib/runtime/node-runtime";
import { findPackageRoot } from "@/lib/runtime/package-root";
import { maybePrintUpdateNotice } from "@/lib/cli/update-notice";
import {
  openStudioInBrowser,
  openStudioWhenReady,
  shouldOpenBrowser,
} from "@/lib/cli/open-browser";

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

/**
 * The Node binary to spawn `next dev` under.
 *
 * Prefers `LIBI_LAUNCHER_NODE` — the shell's own `process.execPath`, set by
 * `bin/libi.js` — over `resolveNodeCommand()`'s libi-managed node. `predev`
 * (`scripts/ensure-native-modules.js`) rebuilds `better-sqlite3` for the
 * SHELL's node, not the managed one; if the two have drifted to different
 * majors, spawning `next dev` under the managed node throws an ABI mismatch
 * on its first DB call. Falls back to `resolveNodeCommand()` when the var is
 * unset or points at a binary that no longer exists (e.g. a hand-invoked
 * `node bin/libi.js`, or a stale/relocated path), matching the behaviour
 * this branch had before `LIBI_LAUNCHER_NODE` existed.
 */
export function resolveDevServerNodeCommand(): string {
  const launcherNode = process.env.LIBI_LAUNCHER_NODE;
  if (launcherNode && fs.existsSync(launcherNode)) return launcherNode;
  return resolveNodeCommand();
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
  // function — `lib/playwright/paths.ts#resolvePlaywrightCoreCli` and
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
  // lib/cli/index.ts for every subcommand (serve-mcp, connect, …), so a
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
  opts: { dirname?: string; open?: boolean } = {},
): Promise<void> {
  port = resolvePort(port, process.env);

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
  // not merely before the production Next.js boot. Today's Category A
  // installers (node runtime, ffmpeg/ffprobe) anchor on LIBI_HOME, but any
  // installer that resolves against `process.cwd()` must see this package's
  // root, not wherever the user typed `npx libi`. Two such paths exist:
  //   - live: `sidecarProjectDir()` (lib/tracking/engine-deps.ts) is
  //     `process.cwd()/mcp/tracking/py`, the project the `tracking-pyenv`
  //     installer `uv sync`s — reached on demand from the same process
  //     (Settings retry, the tracking_engine_install job), so a wrong cwd
  //     would sync a project that does not exist.
  //   - `lib/playwright/paths.ts#resolvePlaywrightCoreCli` walks up from
  //     cwd; it is what exited Category A with 1 on a fresh machine when
  //     the chdir lived later (inside `runProductionServer`). It is also
  //     reached from the first canvas export and the tracker
  //     (`lib/export/ensure-chromium.ts`) — same process, same cwd.
  // Keeping the order is what keeps that class of bug out.
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

  // The URL is printed for every launch, before any browser is involved —
  // auto-open is the convenience, this line is the contract. See
  // lib/cli/open-browser.ts for the whole policy.
  const studioUrl = `http://localhost:${port}`;
  const autoOpen = shouldOpenBrowser({ flag: opts.open, isDevCheckout });

  process.stdout.write(
    `[libi] Starting server on port ${port}…\n` +
      (autoOpen
        ? `[libi] Opening ${studioUrl} in your browser…\n` +
          `[libi] If it doesn't open by itself, visit ${studioUrl}\n`
        : `[libi] Open ${studioUrl}\n`),
  );

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
    // `runProductionServer` resolves only once OUR server is listening, so the
    // handoff needs no readiness polling and can't race a foreign process that
    // already holds the port (that path exits 1 above). Fire and forget — the
    // server keeps the process alive.
    if (autoOpen) void openStudioInBrowser(studioUrl);
    return;
  }

  // Loopback by default — see the matching comment in `runProductionServer`.
  // Resolved locally rather than threaded through as a parameter: this
  // branch and `runProductionServer` are separate functions with no shared
  // scope for it.
  // `||`, not `??`: an empty LIBI_HOST="" would pass `??` and Node binds "" to `::`.
  const host = process.env.LIBI_HOST || "127.0.0.1";
  // Run Next's own CLI through a real Node, instead of shelling out to `npx`:
  // `npx` on Windows is `npx.cmd`, and spawning a `.cmd` without `shell: true`
  // (which would route args through cmd.exe) has thrown EINVAL since Node
  // 20.12 — `spawn("npx", …)` bare fails with ENOENT there for the same
  // reason. `resolveDevServerNodeCommand()`, not `process.execPath`: under a
  // packaged Electron app `process.execPath` is the Electron binary, and with
  // the `runAsNode` fuse off that spawns a second Libi GUI instead of running
  // Node (this branch only runs for a dev checkout today, but the repo's
  // `process.execPath`-as-spawn-target guard is unconditional — see
  // `__tests__/unit/uv-env/install-path-invariants.test.ts`). It prefers the
  // shell's own node (see `resolveDevServerNodeCommand`'s doc comment) over
  // `resolveNodeCommand()`'s libi-managed one, so `next dev`'s native modules
  // match what `predev` just built. `nextBin` is resolved from `projectRoot`
  // (the package root found above, not `process.cwd()`) so it's correct
  // however this module got here — dev checkout, worktree, or a compiled
  // mirror.
  let nextBin: string;
  try {
    nextBin = createRequire(path.join(projectRoot, "package.json")).resolve(
      "next/dist/bin/next",
    );
  } catch (err) {
    process.stderr.write(
      `[libi] could not find next's CLI under ${projectRoot}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
  const child = spawn(resolveDevServerNodeCommand(), [nextBin, "dev", "--port", port, "-H", host], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: port,
      NEXT_EXIT_TIMEOUT_MS: process.env.NEXT_EXIT_TIMEOUT_MS ?? NEXT_DEV_SERVER_EXIT_TIMEOUT_MS,
    },
  });
  // `next dev` is a child process: readiness is only observable from outside,
  // so this branch polls for it. Only reached when a dev checkout opted in
  // (`--open` / `LIBI_OPEN=1`) — the default there is off.
  if (autoOpen) void openStudioWhenReady(studioUrl);
  superviseDevServer(child);
}

/**
 * How long `next dev` lets its server finish after passing it a signal, before
 * it SIGKILLs it. Next's own default is 100 ms, which cuts the server's
 * shutdown (agent processes retired, the MCP endpoint stopped, port files
 * dropped, bounded at about 3 s) off on every Ctrl-C. A value the developer
 * exported wins.
 */
const NEXT_DEV_SERVER_EXIT_TIMEOUT_MS = "5000";
/** How long `next dev` gets to finish after the first signal before its tree is killed. */
const DEV_FORCE_EXIT_MS = 15_000;
/** How long a SIGINT waits before it is passed on to a `next dev` that is still running. */
const DEV_SIGINT_FORWARD_DELAY_MS = 1_000;
/** What a shell reports for a process ended by Ctrl-C. */
const DEV_FORCED_EXIT_CODE = 130;

export interface DevServerSupervisionOptions {
  proc?: Pick<NodeJS.EventEmitter, "on">;
  platform?: NodeJS.Platform;
  exit?: (code: number) => void;
  forceExitMs?: number;
  killTree?: (pid: number) => void;
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
}

/**
 * Keep the CLI alive until `next dev` has exited, and exit with its code: its
 * own code (75, the server asking to be relaunched, included), or 128 plus the
 * signal number when it was killed by a signal. The one exception is a
 * `next dev` that dies by a signal after this CLI was itself asked to shut
 * down: that is the shutdown it was asked for, and exits 0.
 *
 * Without a listener, a Ctrl-C ends this process on the spot (tsx exits it the
 * moment it sees no handler of ours). On Windows that ends `next dev` and its
 * server with it: every child of a Node process sits in a job object that is
 * closed when the parent exits, so the server's shutdown never finishes. On
 * POSIX the prompt came back while the server was still shutting down, and
 * with a failure code.
 *
 * - SIGTERM and SIGHUP are passed on at once (POSIX), a SIGHUP as SIGTERM:
 *   aimed at this process alone, `next dev` would never hear of them. The
 *   server ignores a repeat.
 * - SIGINT is passed on only if `next dev` is still running a second later:
 *   from a terminal it already has it.
 * - A second Ctrl-C is left to bin/libi.js. It passes a SIGINT on to its child
 *   a second after the first, and through tsx that reaches this process looking
 *   exactly like another keypress, so counting it here would kill `next dev` a
 *   second into every ordinary Ctrl-C. The launcher's own second-Ctrl-C and
 *   deadline end this whole tree.
 * - Whatever the signal, `next dev` gets DEV_FORCE_EXIT_MS to finish. After
 *   that its tree is killed on POSIX, and on Windows this process exits, which
 *   closes the job object over the tree.
 *
 * On Windows nothing is passed on: every process attached to the console gets
 * Ctrl-C and a closing window itself, and `kill()` there terminates a process
 * instead of delivering a signal.
 */
export function superviseDevServer(
  child: ChildProcess,
  opts: DevServerSupervisionOptions = {},
): void {
  const proc = opts.proc ?? process;
  const windows = (opts.platform ?? process.platform) === "win32";
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const forceExitMs = opts.forceExitMs ?? DEV_FORCE_EXIT_MS;
  const killTree = opts.killTree ?? killDevProcessTree;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  const running = () => child.exitCode === null && child.signalCode === null;
  const tryKill = (signal: NodeJS.Signals) => {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  };
  const later = (fn: () => void, ms: number) => {
    // Never a reason to stay alive: `next dev`'s own handle keeps this process
    // running, and its exit ends it.
    setTimeout(fn, ms).unref?.();
  };

  let finished = false;
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    exit(code);
  };

  let forcing = false;
  const forceEnd = () => {
    if (forcing || finished) return;
    forcing = true;
    if (!windows && typeof child.pid === "number") killTree(child.pid);
    finish(DEV_FORCED_EXIT_CODE);
  };

  let signalled = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (finished || signalled) return;
    signalled = true;
    if (!windows) {
      // A hangup goes on as SIGTERM. The child is `next dev` itself (no `npx`
      // wrapper in between to relay it), and `next dev` only passes SIGINT
      // and SIGTERM on to its server, so a bare SIGHUP would end `next dev`
      // on Node's default action before its server got a chance to shut down
      // cleanly. The server runs the same shutdown for either signal.
      if (signal !== "SIGINT") tryKill(signal === "SIGHUP" ? "SIGTERM" : signal);
      else
        later(() => {
          if (running() && !forcing) tryKill("SIGINT");
        }, DEV_SIGINT_FORWARD_DELAY_MS);
    }
    later(forceEnd, forceExitMs);
  };
  // A listener is also what keeps a signal from ending this process by default.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    proc.on(signal, () => onSignal(signal));
  }

  child.on("exit", (code, signal) => {
    // A forced end reports 130 itself.
    if (forcing) return;
    if (code === 75) {
      stdout.write(
        "[libi] Server requested restart. Press Ctrl+C and re-run `npx @nagellabs/libi`.\n",
      );
    }
    finish(devExitCodeFor(code, signal, signalled));
  });
  child.on("error", (err) => {
    stderr.write(`[libi] could not start next dev: ${err.message}\n`);
    finish(1);
  });
}

/**
 * The CLI's exit code for a `next dev` that ended with `code`, or was killed
 * by `signal`. Its own code passes through. A signal death is 128 plus the
 * signal number, the way a shell reports one, unless this CLI had itself
 * received a shutdown signal (`shuttingDown`): then it is the shutdown that was
 * asked for, and exits 0. `next dev` itself always ends by `process.exit`, so
 * a signal death with no shutdown asked for is a crash or an OOM kill, and
 * exiting 0 would show npm and test runners a clean run.
 */
export function devExitCodeFor(
  code: number | null,
  signal: NodeJS.Signals | null,
  shuttingDown: boolean,
  signals: Partial<Record<string, number>> = os.constants.signals,
): number {
  if (typeof code === "number") return code;
  if (!signal) return 1;
  return shuttingDown ? 0 : 128 + (signals[signal] ?? 0);
}

/** One live process: pid, parent pid, and its start time where it could be read. */
export type ProcessRow = [pid: number, ppid: number, start?: string];

type RunCommand = (
  file: string,
  args: string[],
  options: { encoding: "utf-8"; stdio: ["ignore", "pipe", "ignore"]; timeout: number },
) => string | Buffer;

type ProcFs = {
  readdirSync: (path: string) => string[];
  readFileSync: (path: string, encoding: "utf-8") => string;
};

/**
 * Every live process as `[pid, parent pid, start]`, or null when there is no
 * way to tell. `/proc` wherever `/proc/self/stat` can be read (Linux), then
 * `/bin/ps` by absolute path, so no PATH entry decides which program runs;
 * each is the other's fallback, so a slim container without ps still has
 * `/proc`.
 *
 * `start` is when the process started, tagged with where it was read from
 * (`starttime:` from field 22 of `/proc/<pid>/stat`, in clock ticks since
 * boot; `lstart:` from ps, to the second). A pid is a number the system hands
 * out again once its process is gone; the pid and its start time together
 * name one process. It is undefined where the source gave none. `/proc` comes
 * first because a step of the wall clock does not move its ticks, while Linux
 * ps prints dates derived from the boot time, which the step does move.
 *
 * The same read as `processTable` in bin/libi.js. That launcher is plain JS
 * that must run without a build, and this module ships compiled into
 * dist-cli/, which carries only compiled TypeScript, so the two keep separate
 * copies. __tests__/unit/bin/tree-kill-parity.test.ts runs the same fixtures
 * through both.
 */
export function readProcessTable(
  run: RunCommand = execFileSync as unknown as RunCommand,
  fsApi: ProcFs = fs as unknown as ProcFs,
): ProcessRow[] | null {
  const fromPs = (): ProcessRow[] | null => {
    try {
      const out = run("/bin/ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart="], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
      });
      const rows: ProcessRow[] = [];
      for (const line of String(out).split("\n")) {
        // "  pid  ppid Fri Sep 11 18:20:48 2026". ps pads the date, so it is
        // compared with its runs of spaces collapsed.
        const [pidText, ppidText, ...date] = line.trim().split(/\s+/);
        const pid = Number(pidText);
        const ppid = Number(ppidText);
        if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
        rows.push([pid, ppid, date.length > 0 ? `lstart:${date.join(" ")}` : undefined]);
      }
      return rows.length > 0 ? rows : null;
    } catch {
      return null;
    }
  };
  const fromProc = (): ProcessRow[] | null => {
    try {
      const rows: ProcessRow[] = [];
      for (const entry of fsApi.readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          // "pid (name) state ppid …". The name may hold spaces and parentheses,
          // so the fields are read from after its last ")": state is field 3,
          // so the parent pid (field 4) is at 1 and the start time (field 22) at 19.
          const stat = fsApi.readFileSync(`/proc/${entry}/stat`, "utf-8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
          const ppid = Number(fields[1]);
          const start = /^\d+$/.test(fields[19] ?? "") ? `starttime:${fields[19]}` : undefined;
          if (Number.isInteger(ppid)) rows.push([Number(entry), ppid, start]);
        } catch {
          /* exited while being read */
        }
      }
      return rows.length > 0 ? rows : null;
    } catch {
      return null;
    }
  };
  let procFirst = false;
  try {
    fsApi.readFileSync("/proc/self/stat", "utf-8");
    procFirst = true;
  } catch {
    /* no /proc, as on macOS */
  }
  return procFirst ? (fromProc() ?? fromPs()) : (fromPs() ?? fromProc());
}

/** Every pid below `rootPid` in `table`, found by following parent links down. */
function descendantsOf(rootPid: number, table: ProcessRow[]): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of table) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);
  }
  const found: number[] = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const pid of children.get(queue.shift()!) ?? []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}

/**
 * Whether two start times read for one pid name the same process. Start times
 * that cannot be compared (one missing, or read from different sources) count
 * as the same, which is what the walk did before it read them at all.
 */
function sameStart(before: string | undefined, after: string | undefined): boolean {
  if (before === undefined || after === undefined) return true;
  if (before.slice(0, before.indexOf(":")) !== after.slice(0, after.indexOf(":"))) return true;
  return before === after;
}

/**
 * SIGKILL `rootPid` and every process below it (POSIX). Returns the pids it
 * killed.
 *
 * The same walk as `killProcessTree` in bin/libi.js (see `readProcessTable`
 * for why there are two copies). Signals only pids found by following parent
 * links down from `rootPid`, one at a time, never a process group (this CLI
 * shares its group with the terminal job), never this process and never pid
 * 1. Everything found is stopped before anything is killed, and the walk
 * repeats until it finds nothing new, so no child can be re-parented out of
 * reach between being found and being killed.
 *
 * A stopped process also keeps its pid, but a process can still exit in the
 * moment between the read that listed it and its SIGSTOP, and its pid can be
 * handed to an unrelated process. So each pid's start time is kept from the
 * read that found it, and the table read after the last SIGSTOP decides: a pid
 * no longer listed is gone, and is not signalled again; a pid is sent SIGCONT
 * instead of SIGKILL only when both its start time changed and it is no longer
 * below the root in that read; everything else is killed. Neither signal alone
 * is enough. A legitimate process whose parent was killed from outside is
 * re-parented but keeps its start time. A step of the wall clock can move
 * every start time ps prints on Linux while nothing left the tree, and a pid
 * recycled to a new child of a tree member is still below the root. The root
 * always counts as in the tree: it is the caller's own child, whose pid is not
 * handed out again before the caller reaps it, and this synchronous walk gives
 * the caller no chance to. From ps the start time is to the second, so a reuse
 * is caught for any process at least a second old when the walk read it; from
 * `/proc` it is to the clock tick.
 *
 * With no process table to read, the root alone is killed, unchecked.
 */
export function killDevProcessTree(
  rootPid: number,
  opts: {
    processTable?: () => ProcessRow[] | null;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    self?: number;
  } = {},
): number[] {
  if (!Number.isInteger(rootPid) || rootPid <= 1) return [];
  const readTable = opts.processTable ?? (() => readProcessTable());
  const kill = opts.kill ?? ((pid: number, signal: NodeJS.Signals) => void process.kill(pid, signal));
  const self = opts.self ?? process.pid;
  const send = (pid: number, signal: NodeJS.Signals) => {
    try {
      kill(pid, signal);
    } catch {
      /* already gone */
    }
  };
  const startsOf = (table: ProcessRow[]) =>
    new Map<number, string | undefined>(table.map(([pid, , start]) => [pid, start]));

  const targets: number[] = [];
  const foundStart = new Map<number, string | undefined>();
  // The table read after every SIGSTOP was sent, which the kill is checked against.
  let settled: ProcessRow[] | null = null;
  let readable = false;
  for (let pass = 0; pass < 8; pass++) {
    const table = readTable();
    if (table) readable = true;
    const starts = table ? startsOf(table) : new Map<number, string | undefined>();
    const fresh = [rootPid, ...(table ? descendantsOf(rootPid, table) : [])].filter(
      (pid) => Number.isInteger(pid) && pid > 1 && pid !== self && !foundStart.has(pid),
    );
    for (const pid of fresh) {
      foundStart.set(pid, starts.get(pid));
      targets.push(pid);
      send(pid, "SIGSTOP");
    }
    if (!table) break;
    if (fresh.length === 0) {
      settled = table;
      break;
    }
  }
  if (!settled && readable) settled = readTable();

  const now = settled ? startsOf(settled) : null;
  const stillInTree = new Set(settled ? [rootPid, ...descendantsOf(rootPid, settled)] : []);
  const killed: number[] = [];
  for (const pid of targets) {
    if (now) {
      if (!now.has(pid)) continue;
      if (!sameStart(foundStart.get(pid), now.get(pid)) && !stillInTree.has(pid)) {
        send(pid, "SIGCONT");
        continue;
      }
    }
    send(pid, "SIGKILL");
    killed.push(pid);
  }
  return killed;
}
