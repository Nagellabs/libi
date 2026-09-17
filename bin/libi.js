#!/usr/bin/env node

// Respawn under tsx for TypeScript + path alias support, with a
// dev-only worktree bootstrap that isolates LIBI_HOME + picks a free
// port when run from inside a linked git worktree. End-users
// (npm-installed `npx @nagellabs/libi`) hit the dev-mode gate and pass through
// unchanged.

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync, spawn } = require("child_process");

// tsx ships as a plain JS script with `#!/usr/bin/env node`. On machines
// where `node` is managed by a version-manager shim (proto, nvm, etc.) that
// reads $HOME, overriding HOME in a subprocess env breaks the shim's config
// lookup, causing it to hang. Use process.execPath (the real Node.js binary
// that is already running us) as the executor and pass tsx as a script
// argument to avoid re-entering the shim layer.
const NODE = process.execPath;

/**
 * Resolve tsx's CLI entry script. Prefer real Node module resolution
 * (`require.resolve`, which walks up ancestor `node_modules/` dirs) over a
 * single hardcoded nested path — a real `npm install`/`npx @nagellabs/libi` consumer
 * install HOISTS `tsx` to the install root's top-level `node_modules/`
 * rather than nesting it under `node_modules/libi/node_modules/`. The old
 * hardcoded-nested-path-only check does not exist there, so `bin/libi.js`
 * threw `MODULE_NOT_FOUND` before running a single line of the actual CLI —
 * found by actually installing + launching a packed tarball, not just
 * checking `npm install` exit codes (see .superpowers/sdd/task-5-report.md).
 * `tsx`'s own `exports` map blocks a direct `tsx/dist/cli.mjs` subpath
 * resolve (same class of restriction documented in lib/install/npm-root.ts
 * for npm's own package) — `tsx/cli` is the exports-map alias for that file.
 */
function resolveTsxScript() {
  try {
    return require.resolve("tsx/cli", { paths: [__dirname] });
  } catch {
    /* fall through to the historical hardcoded candidates below — keeps
     * working for any install layout real resolution doesn't cover. */
  }
  const nested = path.resolve(
    __dirname,
    "..",
    "node_modules",
    "tsx",
    "dist",
    "cli.mjs",
  );
  if (fs.existsSync(nested)) return nested;
  // Fallback to the .bin wrapper if the dist entry doesn't exist (older tsx).
  return path.resolve(__dirname, "..", "node_modules", ".bin", "tsx");
}
const TSX = resolveTsxScript();
const PKG_ROOT = path.resolve(__dirname, "..");
const ENTRY = path.resolve(PKG_ROOT, "lib", "cli", "index.ts");
/**
 * The compiled twin of ENTRY, produced by `scripts/build-cli.js`.
 *
 * An npm-INSTALLED libi cannot run from source at all: tsx applies the
 * tsconfig `paths` matcher only when the importing file's own path has no
 * `node_modules` segment (see `node_modules/tsx/dist/register-*.cjs`), and an
 * installed package is entirely under one — so every `@/…` import in
 * `lib/cli/index.ts`'s graph throws MODULE_NOT_FOUND before the CLI runs a
 * line. Running an extracted copy from OUTSIDE node_modules (which is how this
 * path was previously "verified") does not reproduce it, which is exactly how
 * the bug survived.
 */
const COMPILED_ENTRY = path.resolve(PKG_ROOT, "dist-cli", "lib", "cli", "index.js");

/**
 * True when this copy of libi lives under a `node_modules` directory — the
 * exact condition that disables tsx's alias resolution. Deliberately NOT
 * "does dist-cli exist": preferring compiled output whenever it happens to be
 * on disk would silently run a dev's stale build instead of their working
 * tree. Dev checkouts and the packaged Electron app
 * (`Contents/Resources/app/`) both fail this test and keep running from
 * source, unchanged.
 */
function installedUnderNodeModules() {
  return __dirname.split(path.sep).includes("node_modules");
}
// tsx resolves `@/*` path aliases (used throughout lib/ and mcp/) via
// tsconfig.json's `paths`, discovered by walking up from process.cwd() —
// NOT from ENTRY's own directory. A dev checkout chdirs to the checkout
// root first (below), so cwd == the directory holding tsconfig.json and
// auto-discovery just works. A real `npx @nagellabs/libi`/installed launch does NOT
// chdir (cwd is wherever the user ran the command from, almost never this
// package's own directory), so auto-discovery walks up the WRONG ancestor
// chain and never finds it — `@/lib/...` imports throw MODULE_NOT_FOUND
// before the CLI runs a single line. Passing `--tsconfig` explicitly (same
// pattern already used for the MCP child spawn in
// lib/mcp-config.ts#buildLibiEntry) makes this cwd-independent.
const TSCONFIG = path.resolve(__dirname, "..", "tsconfig.json");

/**
 * Walk up from __dirname looking for a `.git` dir/file. If absent we're
 * an installed npm package, not a dev checkout — skip the bootstrap.
 *
 * The walk STOPS AT THE PACKAGE ROOT (first ancestor with a `package.json`)
 * and never looks above it, so an ancestor's `.git` — the user's own project
 * around `node_modules/libi`, or a `~/.git` dotfiles repo around an extracted
 * runtime — can never make an installed package look like a dev checkout.
 * This decision gates the worktree bootstrap AND the Sentry/analytics
 * dev-vs-install flags below, and its twin in lib/dev/worktree-bootstrap.ts
 * additionally gates `next dev` vs the production server — getting it wrong
 * spawns `next dev` inside the consumer's project. Keep the two in sync.
 */
function inDevCheckout() {
  let dir = __dirname;
  // An installed dependency always sits under a `node_modules` path segment.
  if (dir.split(path.sep).includes("node_modules")) return false;
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return true;
    // Package root reached without a `.git` → an installed/extracted copy.
    if (fs.existsSync(path.join(dir, "package.json"))) return false;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

async function runBootstrap(originalCwd) {
  if (!inDevCheckout()) return {};
  // Use tsx to import the TS module (avoids a build step for the dev path).
  // We invoke it inline via a tiny eval script piped through tsx.
  // Pass `originalCwd` so resolveWorktreeEnv detects the CALLER's worktree,
  // not the post-chdir script-checkout root.
  try {
    const BOOTSTRAP = path.resolve(
      __dirname,
      "..",
      "lib",
      "dev",
      "worktree-bootstrap.ts",
    );
    const json = execFileSync(
      NODE,
      [
        TSX,
        "--eval",
        `import { resolveWorktreeEnv } from ${JSON.stringify(BOOTSTRAP)}; resolveWorktreeEnv({ cwd: ${JSON.stringify(originalCwd)}, startPath: ${JSON.stringify(originalCwd)} }).then(r => process.stdout.write(JSON.stringify(r))).catch(() => process.stdout.write("{}"));`,
      ],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    return JSON.parse(json || "{}");
  } catch {
    return {};
  }
}

/** How long a SIGINT waits before it is passed on to a server that is still running. */
const SIGINT_FORWARD_DELAY_MS = 1_000;
/** A SIGINT closer than this to the first is the same Ctrl-C relayed by npm, not a second one. */
const REPEAT_SIGINT_MIN_GAP_MS = 500;
/** How long the server gets to finish after the first signal before it is killed. */
const FORCE_EXIT_MS = 15_000;
/** How long a forced end on Windows waits for taskkill before exiting anyway. */
const TASKKILL_WAIT_MS = 3_000;
/** What a shell reports for a process ended by Ctrl-C. */
const FORCED_EXIT_CODE = 130;

/**
 * The wrapper's exit code for a server that ended with `code`, or was killed
 * by `signal`: its own code (75, the server asking to be relaunched, passes
 * through like any other), or 128 plus the signal number, the way a shell
 * reports a signal death. Exiting 0 for a killed server made a crash look like
 * a clean run to npm and to test runners.
 */
function exitCodeFor(code, signal, signals = os.constants.signals) {
  if (typeof code === "number") return code;
  if (signal) return 128 + (signals[signal] ?? 0);
  return 1;
}

/**
 * The signal a SIGTERM or SIGHUP caught here is passed on to the server as.
 *
 * A hangup travels as SIGTERM. Under `npm run dev` the process this launcher
 * starts is a tsx wrapper, and tsx relays only SIGINT and SIGTERM to the
 * process it runs: a SIGHUP ends tsx on Node's default action and never reaches
 * the CLI below it. This launcher then saw its child exit and exited too,
 * leaving the dev CLI, `next dev`, the server and its agents running with their
 * ports bound. The server runs the same shutdown for either signal.
 */
function forwardedSignal(signal) {
  return signal === "SIGHUP" ? "SIGTERM" : signal;
}

/**
 * taskkill.exe by absolute path, so neither a missing PATH nor an earlier
 * user-writable PATH entry decides which program runs. The same rule as
 * `taskkillPath` in lib/server/lifecycle/mcp-http-child.ts, which this plain
 * JS launcher cannot import.
 */
function taskkillPath(systemRoot) {
  return path.win32.join(systemRoot || "C:\\Windows", "System32", "taskkill.exe");
}

/**
 * Every live process as `[pid, parent pid, start]`, or null when there is no
 * way to tell. `/proc` wherever `/proc/self/stat` can be read (Linux), then
 * `/bin/ps` by absolute path, for the same reason as `taskkillPath`; each is
 * the other's fallback, so a slim container without ps still has `/proc`.
 *
 * `start` is when the process started, tagged with where it was read from
 * (`starttime:` from field 22 of `/proc/<pid>/stat`, in clock ticks since
 * boot; `lstart:` from ps, to the second). A pid is a number the system hands
 * out again once its process is gone; the pid and its start time together
 * name one process. It is undefined where the source gave none. `/proc` comes
 * first because a step of the wall clock does not move its ticks, while Linux
 * ps prints dates derived from the boot time, which the step does move.
 */
function processTable(run = execFileSync, fsApi = fs) {
  const fromPs = () => {
    try {
      const out = run("/bin/ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart="], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
      });
      const rows = [];
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
  const fromProc = () => {
    try {
      const rows = [];
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
function descendantsOf(rootPid, table) {
  const children = new Map();
  for (const [pid, ppid] of table) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const pid of children.get(queue.shift()) ?? []) {
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
function sameStart(before, after) {
  if (before === undefined || after === undefined) return true;
  if (before.slice(0, before.indexOf(":")) !== after.slice(0, after.indexOf(":"))) return true;
  return before === after;
}

/**
 * SIGKILL `rootPid` and every process below it, on POSIX. Returns the pids it
 * killed.
 *
 * Under `npm run dev` the server this launcher started is a tsx wrapper, and a
 * shutdown that wedged is in a process two or three levels below it. Killing
 * the direct child alone would leave that one running, re-parented away from
 * everything that could still end it.
 *
 * Only pids found by walking down from `rootPid` are signalled, one at a time.
 * Never a process group: this launcher shares its group with the terminal job
 * or npm above it. Never this process either, nor pid 1. Every process found
 * is stopped before any is killed, and the walk repeats until it finds nothing
 * new. A stopped process can neither start a child nor exit, so no child can
 * be re-parented out of the walk's reach between being found and being killed.
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
function killProcessTree(rootPid, opts = {}) {
  if (!Number.isInteger(rootPid) || rootPid <= 1) return [];
  const readTable = opts.processTable ?? (() => processTable());
  const kill = opts.kill ?? ((pid, signal) => process.kill(pid, signal));
  const self = opts.self ?? process.pid;
  const send = (pid, signal) => {
    try {
      kill(pid, signal);
    } catch {
      /* already gone */
    }
  };
  const startsOf = (table) => new Map(table.map(([pid, , start]) => [pid, start]));

  const targets = [];
  const foundStart = new Map();
  // The table read after every SIGSTOP was sent, which the kill is checked against.
  let settled = null;
  let readable = false;
  for (let pass = 0; pass < 8; pass++) {
    const table = readTable();
    if (table) readable = true;
    const starts = table ? startsOf(table) : new Map();
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
  const killed = [];
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

/**
 * Stand between the terminal and the libi server `child`, and exit when it
 * does.
 *
 * A terminal's Ctrl-C reaches this process and the server at the same moment.
 * The server shuts itself down on it (agent processes retired, the MCP
 * endpoint stopped, port files dropped) and then exits, and the wrapper has to
 * outlive that: on Windows every child of a Node process sits in a job object
 * that is closed with its parent, so a wrapper that exits on the signal ends
 * the server before any of its shutdown runs.
 *
 * Merely staying alive would leave nothing but the server able to end the
 * wrapper, so:
 *   - SIGTERM and SIGHUP are passed to the server at once, a SIGHUP as SIGTERM
 *     (`forwardedSignal`). Aimed at this pid alone (a service manager, a
 *     launcher stopping its direct child), the server would otherwise never
 *     hear of them; a repeat is harmless to it.
 *   - SIGINT is not passed on at once. From a terminal the server already has
 *     it, and sending it here too would deliver it twice. It is passed on only
 *     if the server is still running a second later, which is what a SIGINT
 *     sent to this pid alone (`kill -INT`, npm or pm2 relaying to their child)
 *     looks like.
 *   - a second Ctrl-C ends it: the server and every process under it are
 *     killed (`killProcessTree`) and the wrapper exits 130.
 *     One arriving within half a second of the first is npm relaying the same
 *     keypress, and does not count.
 *   - whatever the signal, the server gets FORCE_EXIT_MS to finish, then is
 *     killed the same way. Its own shutdown is bounded at a few seconds.
 *
 * On Windows nothing is passed on: every process attached to the console gets
 * Ctrl-C and a closing window itself, and `kill()` there terminates a process
 * outright instead of delivering a signal, which is exactly the cut-off
 * shutdown this exists to avoid. A forced end uses `taskkill /T /F` on the
 * server's tree.
 *
 * `opts` replaces the process, platform, clock, exit and spawn, so the timing
 * can be tested without real signals or a real 15 s wait.
 */
function superviseServer(child, opts = {}) {
  const proc = opts.proc ?? process;
  const windows = (opts.platform ?? process.platform) === "win32";
  const now = opts.now ?? (() => Date.now());
  const exit = opts.exit ?? ((code) => process.exit(code));
  const forceExitMs = opts.forceExitMs ?? FORCE_EXIT_MS;
  const spawnTaskkill = opts.spawn ?? spawn;
  const killTree = opts.killTree ?? killProcessTree;
  const systemRoot = opts.systemRoot ?? (process.env.SystemRoot || process.env.windir);

  const running = () => child.exitCode === null && child.signalCode === null;
  const tryKill = (signal) => {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  };
  // Never a reason to stay alive: the server's own handle is what keeps this
  // process running, and its exit ends it.
  const later = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    if (timer && typeof timer.unref === "function") timer.unref();
  };

  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    exit(code);
  };

  let forcing = false;
  const forceEnd = () => {
    if (forcing || finished) return;
    forcing = true;
    if (!windows) {
      // The server and every process under it, not just the direct child: under
      // `npm run dev` that child is tsx, and what wedged is further down.
      if (typeof child.pid === "number") killTree(child.pid);
      else tryKill("SIGKILL");
      finish(FORCED_EXIT_CODE);
      return;
    }
    // taskkill runs inside this process's job object, as the server does, so
    // exiting before it is done would cut it off too. If it never finishes,
    // exiting still ends the whole tree through that job object. Not unref'd:
    // once the server is gone, this timer may be all that is left to exit on.
    setTimeout(() => finish(FORCED_EXIT_CODE), TASKKILL_WAIT_MS);
    const fallBack = () => {
      if (running()) tryKill();
      finish(FORCED_EXIT_CODE);
    };
    try {
      const taskkill = spawnTaskkill(taskkillPath(systemRoot), ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
      taskkill.on("error", fallBack);
      taskkill.on("exit", (code) => (code === 0 ? finish(FORCED_EXIT_CODE) : fallBack()));
    } catch {
      fallBack();
    }
  };

  let firstSignalAt = null;
  const onSignal = (signal) => {
    if (finished) return;
    const at = now();
    if (firstSignalAt === null) {
      firstSignalAt = at;
      if (!windows) {
        // A SIGTERM or SIGHUP sent to the whole group (a closed terminal, a
        // `kill -- -pgid`) has already reached the server, so this delivers it
        // a second time. That is accepted: the server's shutdown handler
        // (`cleanupSignal` in lib/server/lifecycle/category-b.ts) returns at
        // once on a repeat, and any handler added there must do the same.
        // A hangup goes on as SIGTERM, the one of the two a tsx wrapper passes
        // down to the server instead of dying on it (see `forwardedSignal`).
        if (signal !== "SIGINT") tryKill(forwardedSignal(signal));
        else
          later(() => {
            if (running() && !forcing) tryKill("SIGINT");
          }, SIGINT_FORWARD_DELAY_MS);
      }
      later(forceEnd, forceExitMs);
      return;
    }
    if (signal === "SIGINT" && at - firstSignalAt > REPEAT_SIGINT_MIN_GAP_MS) forceEnd();
  };
  // A listener is also what keeps a signal from ending this process by default.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) proc.on(signal, () => onSignal(signal));

  child.on("exit", (code, signal) => {
    // A forced end reports 130 itself, once its kill is done.
    if (forcing) return;
    finish(exitCodeFor(code, signal));
  });
  child.on("error", (err) => {
    try {
      proc.stderr.write(`[libi] could not start the libi server: ${err && err.message ? err.message : err}\n`);
    } catch {
      /* stderr gone */
    }
    finish(1);
  });
}

// Run only as the launcher. A test loads this file to drive `superviseServer`,
// and must not start a server by doing so.
if (require.main === module) void (async () => {
  // In a dev checkout, normalize cwd to THIS checkout's root before anything
  // else. The worktree bootstrap + `next dev` both key off process.cwd(), so
  // when a preview/launcher runs a worktree's bin/libi.js from the canonical
  // repo's cwd, they'd otherwise resolve the canonical checkout (serving main
  // on the default port) instead of the worktree this script belongs to.
  // __dirname is <checkout>/bin, so the checkout root is one level up.
  //
  // Capture the original cwd BEFORE we chdir, so runBootstrap can detect
  // which git worktree the caller was actually running from. The chdir is
  // only for next dev / tsx spawning; worktree-bootstrap uses the original.
  const originalCwd = process.cwd();
  if (inDevCheckout()) {
    try {
      process.chdir(path.resolve(__dirname, ".."));
    } catch {
      /* best-effort */
    }
  }
  const result = await runBootstrap(originalCwd);
  const env = { ...process.env };
  // The caller's true launch directory. We chdir to the checkout root above
  // (dev), so process.cwd() is wrong for `libi connect` with no dir argument
  // ("connect the folder I ran libi from"). The CLI + spawned server read
  // this instead.
  env.LIBI_LAUNCH_CWD = originalCwd;
  // The shell's own Node binary, so the dev branch of `lib/cli/studio.ts` can
  // spawn `next dev` under it instead of the libi-managed one — see
  // `resolveDevServerNodeCommand()` there. Only a dev checkout ever reads
  // this; gated like the Sentry/analytics flags below so it doesn't leak the
  // machine's node path (home dir, version-manager layout) into a production
  // install's agent/MCP/terminal children for no benefit.
  if (inDevCheckout()) {
    env.LIBI_LAUNCHER_NODE = NODE;
  }
  // Sentry: enable error/log tracking ONLY for genuine end-user installs, never
  // a developer's working clone. `inDevCheckout()` (the .git-presence signal
  // used above) is exactly that distinction — an installed `npx @nagellabs/libi` package
  // has no .git. The flag is read by lib/sentry/config.ts inside the Next
  // process. A contributor can still force it on by exporting the var first.
  if (env.NEXT_PUBLIC_LIBI_SENTRY === undefined) {
    env.NEXT_PUBLIC_LIBI_SENTRY = inDevCheckout() ? "0" : "1";
  }
  // Mirror the hard kill-switch under a NEXT_PUBLIC_ name so it actually
  // reaches the BROWSER bundle. Next.js only exposes NEXT_PUBLIC_*-prefixed
  // vars to client code, so `LIBI_SENTRY_DISABLED=1` alone shut off the server
  // while the renderer kept reporting (browser tracing, release-health
  // sessions, DOM-path INP spans). lib/sentry/config.ts honours either name.
  if (
    env.LIBI_SENTRY_DISABLED === "1" &&
    env.NEXT_PUBLIC_LIBI_SENTRY_DISABLED === undefined
  ) {
    env.NEXT_PUBLIC_LIBI_SENTRY_DISABLED = "1";
  }
  // Analytics: same policy as Sentry — ON only for genuine installs (no .git),
  // OFF in a dev checkout. A contributor can force it on (sandbox testing) by
  // exporting NEXT_PUBLIC_LIBI_ANALYTICS=1 before launch.
  if (env.NEXT_PUBLIC_LIBI_ANALYTICS === undefined) {
    env.NEXT_PUBLIC_LIBI_ANALYTICS = inDevCheckout() ? "0" : "1";
  }
  if (result.libiHome) env.LIBI_HOME = result.libiHome;
  if (typeof result.port === "number") env.LIBI_PORT = String(result.port);
  // Worktree name → server reads this via /api/runtime so the chat sidebar
  // can badge the brand. Only set when in a worktree (omitted for canonical).
  if (typeof result.worktreeName === "string" && result.worktreeName.length > 0) {
    env.LIBI_WORKTREE_NAME = result.worktreeName;
  }
  // Merge canonical-repo dotenv (`.env.local`, `.env`) without overwriting
  // anything the user already exported in their shell — shell wins, matching
  // the Next.js precedence model.
  if (result.envOverrides && typeof result.envOverrides === "object") {
    for (const [k, v] of Object.entries(result.envOverrides)) {
      if (env[k] === undefined && typeof v === "string") env[k] = v;
    }
  }

  if (result.logLine) {
    process.stderr.write(result.logLine + "\n");
  }

  const argv = process.argv.slice(2);
  // Only inject --port for the studio: no argv at all, an explicit `studio`,
  // or flags with no subcommand in front of them (`libi --no-open`). A
  // subcommand — `serve-mcp`, `serve-mcp-http`, `serve-mcp-tracking`,
  // `connect`, `export` — never starts with `-`, so the third clause already
  // excludes every one of them; an allowlist inside it could not match
  // anything and is gone. Only when the user didn't pass --port / -p himself.
  const isStudio = argv.length === 0 || argv[0] === "studio" || argv[0].startsWith("-");
  const hasPortFlag = argv.some((a) => a === "--port" || a === "-p");
  if (isStudio && !hasPortFlag && typeof result.port === "number") {
    argv.push("--port", String(result.port));
  }

  // Dual mode: source through tsx for a dev checkout / the packaged Electron
  // app; the compiled CommonJS entry for an npm install, where tsx cannot
  // resolve `@/…` at all. Missing compiled output is a HARD failure with an
  // actionable message — silently falling back to tsx there would produce a
  // MODULE_NOT_FOUND stack from deep inside libi with no hint of the cause.
  let launchArgs;
  if (installedUnderNodeModules()) {
    if (!fs.existsSync(COMPILED_ENTRY)) {
      process.stderr.write(
        "\n[libi] This install is missing its compiled CLI (" +
          COMPILED_ENTRY +
          ").\n" +
          "[libi] An installed libi cannot run from TypeScript source: tsx disables\n" +
          "[libi] tsconfig `paths` for anything under node_modules, so every @/ import fails.\n" +
          "[libi] Either this tarball was packed without `npm run build:cli` (please report it),\n" +
          "[libi] or this is a dev checkout sitting under a directory literally named\n" +
          "[libi] `node_modules` — move it outside node_modules, or run `npm run build:cli`\n" +
          "[libi] yourself and it will launch from dist-cli/ like a real install.\n\n",
      );
      process.exit(1);
    }
    launchArgs = [COMPILED_ENTRY, ...argv];
  } else {
    launchArgs = [TSX, "--tsconfig", TSCONFIG, ENTRY, ...argv];
  }

  // Spawned, not run synchronously: a blocked wrapper could not act on any
  // signal, so a shutdown that wedged would hold the terminal with no way out.
  superviseServer(spawn(NODE, launchArgs, { stdio: "inherit", env }));
})();

module.exports = {
  superviseServer,
  exitCodeFor,
  forwardedSignal,
  taskkillPath,
  killProcessTree,
  descendantsOf,
  processTable,
};
