/**
 * The HTTP MCP aggregator child, owned by the libi server.
 *
 * `mcp/http/index.ts` (`libi serve-mcp-http`) is the single endpoint every
 * agent surface talks to, so it must be up whenever libi is up. This module
 * is the supervisor: spawn it, wait for `/healthz`, publish
 * `<LIBI_HOME>/mcp-port` (the ONLY discovery mechanism for the aggregator,
 * mirroring `<LIBI_HOME>/port` for the studio), restart it with backoff when
 * it dies unexpectedly, and stop it on shutdown.
 *
 * These rules are load-bearing:
 *   - the port file is written only AFTER health, never before. A port file
 *     pointing at a socket that is not listening yet is worse than no file at
 *     all — clients resolve it, fail, and blame the aggregator.
 *   - `stop()` latches the state before killing, so the exit it causes is
 *     never mistaken for a crash and restarted. A shutdown must not
 *     resurrect the child.
 *   - a child that cannot BIND is moved to another port, not relaunched into
 *     the same collision. The default port is the same 3457 for everyone, so
 *     two instances starting together both pick it and one of them has to
 *     yield (`repickIfTaken`).
 *   - EVERY launch is health-checked, restarts included. A restart that comes
 *     up wedged is a failure, not a recovery, and has to keep counting against
 *     the restart budget rather than be recorded as success.
 *   - a user-driven `restart()` keeps the port unless someone else took it
 *     while the child was down. A user's own CLI registration names the URL,
 *     so moving it is a last resort, and one that has to notify. The old
 *     child's listening socket outlives its SIGTERM (it closes sessions one by
 *     one first), so the restart waits for that child to exit and re-probes
 *     the same port for a moment before concluding someone else holds it.
 *   - whatever port a child goes HEALTHY on is the one published. The file
 *     and `onPortChanged` follow health, never a pick, so a relaunch that
 *     fails on a new port and recovers there through the crash path still
 *     announces it.
 *   - one relauncher at a time. The crash path and a user restart both
 *     relaunch; each re-checks after every await that it still owns the
 *     child it set out to replace, so neither spawns a second child the
 *     other then forgets.
 *   - a child that fails to SPAWN is supervised exactly like one that exits.
 *     Node reports ENOENT / EACCES / EAGAIN / EMFILE as an async `error` event
 *     and never emits `exit` for it; unlistened, that event is an uncaught
 *     exception in the libi server, and unsupervised it leaves the state
 *     `running` behind a stale port file.
 *   - a FIRST launch that never becomes healthy ends `gave-up`, it does not
 *     reject. A handle has to exist for the Restart button to recover it;
 *     without one the endpoint stayed down until libi itself was restarted.
 *     The first launch also gets a longer window than a relaunch, because it
 *     competes with everything else a cold start does.
 *   - every failed launch reports the child's own last output (scrubbed), so
 *     "did not become healthy" is never the whole story.
 *   - a launch is healthy only when `/healthz` echoes the token that launch
 *     was handed. Two instances starting together both pick 3457, and the
 *     loser's child lives on briefly after failing to bind while the winner
 *     already answers there; a bare 200 published the other instance's port.
 *   - every signal reaches the child's whole process tree
 *     (`signalChildTree`). Under tsx the real server is a grandchild, and a
 *     SIGKILL to the wrapper alone left it serving the port unsupervised.
 *   - the child's stdin is a pipe nothing ever writes to, and a supervised
 *     child shuts down when it closes. Its only write end lives in this
 *     process, so the pipe closes however this process ends (a closed
 *     terminal, a test runner's group SIGKILL, a crash, Force Quit), and none
 *     of those can leave the endpoint serving a port for nobody. On Windows
 *     this is a backstop rather than the usual path: a `taskkill /F` on the
 *     libi server was observed to end the aggregator through the job object
 *     described below, before its stdin pipe ever closed.
 *   - the handle exists from the first spawn (`onHandle`), so quitting libi
 *     while a first launch is still inside its health window stops the child.
 *   - every launch is told which server it belongs to (`LIBI_SERVER_PORT`),
 *     restarts included. `<LIBI_HOME>/port` names whichever libi on the home
 *     booted last, and a child that followed it once sent every tool call to
 *     a second launch that had already exited.
 *   - `mcp-port` is removed only while THIS supervisor owns it: it wrote the
 *     file, has not dropped it since, and the file still names that port. Two
 *     instances on one home share the file; stopping one must not strand the
 *     other's clients. A first launch that gave up owns nothing, and removes a
 *     file already there only when it names no port or a port nothing
 *     listens on, since a live one is another instance's endpoint.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { serverLogger as logger } from "@/lib/logger";
import {
  getMcpPortFile,
  parseMcpPortEnv,
  removePortFileIfOwned,
  resolvePortToPublish,
  DEFAULT_MCP_PORT,
  LIBI_SERVER_PORT_ENV,
  MCP_HEALTH_TOKEN_ENV,
  MCP_SUPERVISED_ENV,
} from "@/lib/libi-home";
import { isWindows } from "@/lib/platform";
import { buildLibiHttpEntry } from "@/lib/mcp-config";
import { redactCliOutput, scrubSecrets } from "@/lib/security/secret-scrub";

export interface McpHttpChildHandle {
  /** The port the current (or last) launch is on: the one status surfaces name. */
  port: number;
  /**
   * The port a URL handed out now must name: the last one published, or the
   * current launch's own before anything was. It lags `port` on purpose while
   * a relaunch on a moved port has not passed its health check. A later
   * recovery onto any other port fires `onPortChanged`, which rebuilds what
   * holds this one, and a recovery onto this one needs no rebuild.
   */
  advertisedPort: number;
  /**
   * The port last published, or null while nothing has been. A first launch
   * that gave up leaves it null, and then `advertisedPort` names a port no
   * URL outside this process was ever given.
   */
  publishedPort: number | null;
  stop(): Promise<void>;
  /**
   * Stop the child and relaunch it (same port first), resetting the restart
   * budget and health-checking the replacement. Recovers `gave-up`, including
   * a first launch that never came up. Rejects when the supervisor is stopped,
   * still on its first launch, already restarting, or the relaunch is
   * unhealthy.
   */
  restart(): Promise<void>;
  status(): "running" | "restarting" | "gave-up" | "stopped";
  /**
   * Whether a `/healthz` body came from the child this supervisor runs right
   * now: it echoes that launch's token, and that child is still alive. False
   * for any other body, one from an earlier launch included, and while a
   * crashed child's replacement has not been spawned yet. The token itself
   * never leaves the supervisor.
   */
  ownsHealthAnswer(body: unknown): boolean;
}

export interface McpHttpChildDeps {
  spawn?: typeof nodeSpawn;
  fetch?: typeof fetch;
  /**
   * The launch command. `mode` is how `resolveEntrySpawn` resolved it: under
   * `tsx` the server runs as a grandchild, so the child gets a process group
   * of its own to signal; `compiled` is a single process and needs none. An
   * entry that does not say is treated as a wrapper.
   */
  entry?: () => { command: string; args: string[]; env: Record<string, string>; mode?: "tsx" | "compiled" };
  portFile?: string;
  pickPort?: () => Promise<number>;
  /**
   * How long a RELAUNCH (crash path, user restart) gets to answer `/healthz`.
   * Default 10 s. It is also the first launch's window when
   * `firstHealthTimeoutMs` is not given, so pinning only this pins every launch.
   */
  healthTimeoutMs?: number;
  /**
   * How long the FIRST launch gets. Default 30 s: a first boot competes with
   * everything else a cold start does (a fresh install being scanned, Next
   * compiling), and on a loaded machine an aggregator that is healthy in
   * 1.5 s when quiet has missed a 10 s window.
   */
  firstHealthTimeoutMs?: number;
  /**
   * How long one `/healthz` attempt may wait for an answer. Default 5 s. An
   * attempt also ends the moment its child exits, so this bounds only a child
   * that is alive and slow, or a listener that accepts and never answers; it
   * never delays noticing a child that died.
   */
  healthAttemptTimeoutMs?: number;
  restartDelayMs?: number;
  maxRestarts?: number;
  healthyResetMs?: number;
  onGaveUp?: (err: Error) => void;
  /** Probe used to notice that someone else took our port. */
  isFree?: (port: number) => Promise<boolean>;
  /**
   * Called once a child is healthy on a different port from the one last
   * published, so everything holding the old URL (ACP session configs) is
   * rebuilt. Never fires for the first publish of a boot that came up healthy;
   * does fire for the first publish after a first launch that gave up, since
   * configs built meanwhile named a fallback URL.
   */
  onPortChanged?: (newPort: number) => void;
  /**
   * Receives the handle as soon as the first child is spawned, before its
   * health wait (up to `firstHealthTimeoutMs`). The returned promise settles
   * only after that wait, and a shutdown inside it can only stop a child whose
   * handle it can find.
   */
  onHandle?: (handle: McpHttpChildHandle) => void;
  /**
   * Deliver a signal to a child and everything under it. Default
   * `signalChildTree`. A unit test's fake child carries a made-up pid, and
   * signalling that pid's process group could reach a real process.
   */
  killTree?: (c: ChildProcess, signal: "SIGTERM" | "SIGKILL") => void;
  /**
   * Signal a whole process group by its id, ignoring a group that is gone.
   * Used when a group leader exits (see `launch`). Injectable for the same
   * reason as `killTree`.
   */
  signalGroup?: (pgid: number, signal: "SIGTERM") => void;
  /** A fresh `/healthz` identity token for each launch. Default: 16 random bytes, hex. */
  healthToken?: () => string;
  /**
   * The port of the libi server this supervisor runs in, handed to every
   * launch as `LIBI_SERVER_PORT` so the child's tools reach THIS server rather
   * than whichever one last wrote `<LIBI_HOME>/port`. Read at each launch.
   * Default: `resolvePortToPublish().port`, the value Category B writes to
   * that file.
   */
  serverPort?: () => string;
}

/** How long a kill waits for a SIGTERM to land before escalating. */
const STOP_GRACE_MS = 2_000;
/**
 * How long a kill waits for the `exit` a SIGKILL causes. The signal is
 * delivered at once, but the socket is released only when the process is
 * actually gone; bounded, because a process that survives SIGKILL must not
 * wedge a restart or a shutdown.
 */
const KILL_EXIT_WAIT_MS = 1_000;
/**
 * How long a user restart keeps re-probing the SAME port before re-picking.
 * Covers the kernel releasing a socket just after the old child's `exit`.
 */
const PORT_RELEASE_WAIT_MS = 500;
/** Gap between those re-probes. */
const PORT_RELEASE_POLL_MS = 100;
/** Gap between `/healthz` attempts while waiting for the child to come up. */
const HEALTH_POLL_MS = 100;
/**
 * How Windows reports a process it ended for a console event
 * (STATUS_CONTROL_C_EXIT). Node reports the exit code unsigned; the signed
 * form is accepted too. The supervised child ignores Ctrl-C, so for it this
 * means the console window closed, or a logoff or shutdown.
 */
const STATUS_CONTROL_C_EXIT = 0xc000013a;
const STATUS_CONTROL_C_EXIT_SIGNED = STATUS_CONTROL_C_EXIT - 2 ** 32;
/** Longer than the ~5 s Windows waits on each process's close handler, so the server hears the close first. */
const CONSOLE_CLOSE_GRACE_MS = 6_000;
/**
 * How long one `/healthz` attempt may wait for an answer. Something that
 * accepts the connection and never answers would otherwise hold a single
 * attempt past the whole health window. Generous, because an attempt is also
 * abandoned the moment its child exits: the cap costs nothing when a launch
 * fails, and a CPU-starved machine whose child answers late is not cut off.
 */
const HEALTH_ATTEMPT_TIMEOUT_MS = 5_000;
/** Health window for the first launch. See `McpHttpChildDeps.firstHealthTimeoutMs`. */
const FIRST_HEALTH_TIMEOUT_MS = 30_000;
/** Health window for every relaunch. */
const HEALTH_TIMEOUT_MS = 10_000;
/** Lines of each child's own output (stderr and stdout) kept for a failure report. */
const OUTPUT_TAIL_LINES = 20;
/** How many of those an error message carries. */
const ERROR_TAIL_LINES = 5;
/** Per-line cap, so one runaway line cannot bloat a log record or an error. */
const OUTPUT_LINE_MAX = 300;
/** Environment variable NAMES whose values are masked in captured output. */
const SECRET_ENV_NAME = /key|token|secret|passw|credential|auth|cookie/i;
/** Size of each launch's `/healthz` identity token, in random bytes. */
const HEALTH_TOKEN_BYTES = 16;

/**
 * Scrub a child's captured output before it is logged or put in an error:
 * every secret-named value from the environment the child was launched with
 * (a child can only echo what it was handed), then the bearer-token and long
 * `=value` shapes `redactCliOutput` masks. Values under 8 characters are left
 * alone; masking one would shred ordinary words.
 */
export function scrubChildOutput(lines: readonly string[], env: Record<string, string>): string[] {
  const secrets = Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value);
  return lines.map((line) => redactCliOutput(scrubSecrets(line, secrets)));
}

/**
 * Signal the aggregator child and every process under it.
 *
 * In a dev checkout and in the packaged desktop app the child is tsx's CLI
 * (`lib/runtime/compiled-entry.ts` picks that mode whenever libi is not
 * installed under node_modules), and tsx runs the real server as a separate
 * grandchild, relaying only SIGINT and SIGTERM to it. A SIGKILL to the wrapper
 * alone left that grandchild serving the port with nothing supervising it: it
 * outlived libi, and every later launch found its own port taken and moved.
 *
 * So on POSIX a tsx child leads its own process group (`detached` at spawn)
 * and the whole group is signalled; a child that leads none (the compiled
 * entry is a single process) gets the signal directly. Windows has no process
 * groups to signal, so `taskkill /T /F` walks the tree instead. It can only
 * force, which is all a `kill()` on Windows ever did.
 */
export function signalChildTree(
  c: ChildProcess,
  signal: "SIGTERM" | "SIGKILL",
  deps: {
    windows?: boolean;
    spawn?: typeof nodeSpawn;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    /** `%SystemRoot%`, where taskkill.exe lives. Default: the environment's. */
    systemRoot?: string;
  } = {},
): void {
  const pid = c.pid;
  // Never spawned: there is no tree, only the handle.
  if (pid === undefined) {
    c.kill(signal);
    return;
  }
  const alive = () => c.exitCode === null && (c.signalCode ?? null) === null;
  if (deps.windows ?? isWindows()) {
    // Whatever taskkill could not do, the direct child is still stopped.
    let fellBack = false;
    const fallBack = () => {
      if (fellBack || !alive()) return;
      fellBack = true;
      c.kill(signal);
    };
    try {
      const taskkill = (deps.spawn ?? nodeSpawn)(taskkillPath(deps.systemRoot), ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
      // It could not run at all, or it ran and failed (access denied, or the
      // tree changing under it).
      taskkill.on("error", fallBack);
      taskkill.on("exit", (code) => {
        if (code !== 0) fallBack();
      });
      taskkill.unref();
    } catch {
      fallBack();
    }
    return;
  }
  const kill = deps.kill ?? ((p: number, s: NodeJS.Signals) => process.kill(p, s));
  try {
    kill(-pid, signal);
  } catch (err) {
    // No such group while the child is alive means it does not lead one; any
    // other failure (EPERM) means the group could not be reached. Either way
    // the direct child still gets the signal. A group that is gone because the
    // child exited needs nothing.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH" || alive()) c.kill(signal);
  }
}

/**
 * taskkill.exe by absolute path. A bare `taskkill` is looked up through PATH,
 * which the packaged app's environment may not carry at all, and where an
 * earlier user-writable directory can put a different `taskkill.exe` in front
 * of the system's.
 */
export function taskkillPath(systemRoot: string | undefined = process.env.SystemRoot ?? process.env.windir): string {
  return path.win32.join(systemRoot || "C:\\Windows", "System32", "taskkill.exe");
}

/** Signal a process group by id; a group that no longer exists needs nothing. */
function signalGroupBestEffort(pgid: number, signal: "SIGTERM"): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    /* the group left with its leader */
  }
}

/** `unref()` a child or one of its pipes, when the object has one (a test's fake may not). */
function unrefHandle(h: unknown): void {
  const unref = (h as { unref?: unknown } | null | undefined)?.unref;
  if (typeof unref === "function") unref.call(h);
}

/** The `healthToken` a `/healthz` body carries, or undefined for any other body. */
async function echoedHealthToken(r: Response): Promise<unknown> {
  try {
    const body = (await r.json()) as { healthToken?: unknown } | null;
    return body?.healthToken;
  } catch {
    return undefined;
  }
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

/** Injectable probes — the real ones bind a socket, which a unit test cannot. */
export interface PickPortDeps {
  isFree?: (port: number) => Promise<boolean>;
  freePort?: () => Promise<number>;
}

/**
 * `LIBI_MCP_PORT` if set; else 3457 when free; else studio + 1 when free;
 * else any free port.
 *
 * The order is what makes a `libi connect` registration SURVIVE a restart.
 * `claude mcp add --transport http libi <url>` writes the URL statically into
 * `~/.claude.json`, and the packaged desktop app binds its studio port with
 * `listen(0)` (`lib/server/next-server.ts`) — so a port derived from the
 * studio's moves on every launch and the saved URL reads `Failed to connect`
 * on the second one. A fixed default is stable across launches; studio + 1
 * remains as the second-instance escape hatch, and a free port as the last
 * resort so a busy machine still boots.
 */
export async function pickMcpHttpPort(
  env: NodeJS.ProcessEnv = process.env,
  deps: PickPortDeps = {},
): Promise<number> {
  const free = deps.isFree ?? isFree;
  const anyFree = deps.freePort ?? freePort;
  // An explicit override is obeyed even when busy: the listen will fail
  // loudly, which is what someone who pinned a port wants to see. A value that
  // is not a port is NOT a pin — it must not short-circuit the chain below.
  const pinned = parseMcpPortEnv(env.LIBI_MCP_PORT);
  if (pinned !== null) return pinned;
  if (env.LIBI_MCP_PORT) {
    logger.warn(
      { tag: "mcp-http", op: "bad_mcp_port_env", value: env.LIBI_MCP_PORT },
      "LIBI_MCP_PORT is not a port number; picking a port normally",
    );
  }

  if (await free(DEFAULT_MCP_PORT)) return DEFAULT_MCP_PORT;

  const studio = Number.parseInt(env.PORT ?? env.LIBI_PORT ?? "3456", 10);
  const derived = Number.isInteger(studio) ? studio + 1 : NaN;
  if (
    Number.isInteger(derived) &&
    derived > 0 &&
    derived <= 65535 &&
    derived !== DEFAULT_MCP_PORT &&
    (await free(derived))
  ) {
    logger.info(
      { tag: "mcp-http", op: "port_fallback", preferred: DEFAULT_MCP_PORT, chosen: derived },
      "default aggregator port is busy; using the studio port + 1",
    );
    return derived;
  }

  const fallback = await anyFree();
  logger.warn(
    { tag: "mcp-http", op: "port_fallback", preferred: DEFAULT_MCP_PORT, derived, fallback },
    "default aggregator port and studio port + 1 are busy; using a free port",
  );
  return fallback;
}

/**
 * Spawn the HTTP MCP aggregator, wait for `/healthz`, publish the port file,
 * and keep it alive: an unexpected exit is restarted (exponential backoff) up
 * to `maxRestarts`, each restart health-checked in turn; after that we give
 * up, drop the port file, log, and leave Agents → Libi MCP to show the state,
 * with its Restart button, rather than spinning forever. A restart that stays
 * healthy for `healthyResetMs` returns
 * the budget it spent, so a rare crash never accumulates into a give-up.
 *
 * A first launch that never becomes healthy does NOT reject. It resolves a
 * handle in `gave-up` with no port file, after logging the child's last
 * output, so the studio keeps booting (agents without libi's tools beat no
 * studio) and `restart()` can bring the endpoint up without restarting libi.
 * It rejects only when a launch could not be attempted at all (the entry does
 * not resolve, or the port picker threw), which is a broken install rather
 * than a slow machine. The handle itself goes to `onHandle` as soon as the
 * first child exists, long before this resolves.
 */
export async function startMcpHttpChild(deps: McpHttpChildDeps = {}): Promise<McpHttpChildHandle> {
  const spawn = deps.spawn ?? nodeSpawn;
  const doFetch = deps.fetch ?? fetch;
  const killTree = deps.killTree ?? ((c: ChildProcess, signal: "SIGTERM" | "SIGKILL") => signalChildTree(c, signal));
  const signalGroup = deps.signalGroup ?? signalGroupBestEffort;
  const newHealthToken = deps.healthToken ?? (() => randomBytes(HEALTH_TOKEN_BYTES).toString("hex"));
  const entry = deps.entry ?? buildLibiHttpEntry;
  const portFile = deps.portFile ?? getMcpPortFile();
  const pickPort = deps.pickPort ?? pickMcpHttpPort;
  const portIsFree = deps.isFree ?? isFree;
  const serverPort = deps.serverPort ?? (() => resolvePortToPublish().port);
  // Mutable: a child that cannot bind is moved to a fresh port rather than
  // relaunched into the same collision. `handle.port` reads it through a
  // getter so every status surface follows.
  let port = await pickPort();
  const healthTimeoutMs = deps.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  const firstHealthTimeoutMs = deps.firstHealthTimeoutMs ?? deps.healthTimeoutMs ?? FIRST_HEALTH_TIMEOUT_MS;
  const healthAttemptTimeoutMs = deps.healthAttemptTimeoutMs ?? HEALTH_ATTEMPT_TIMEOUT_MS;
  const restartDelayMs = deps.restartDelayMs ?? 500;
  const maxRestarts = deps.maxRestarts ?? 3;
  const healthyResetMs = deps.healthyResetMs ?? 60_000;

  let child: ChildProcess | null = null;
  let restarts = 0;
  /**
   * The port last written to `<LIBI_HOME>/mcp-port` and announced — `null`
   * until the first health check passes. It is deliberately NOT cleared when
   * the file is dropped (gave-up, a failed user restart): the file going away
   * rebuilds nothing, so every ACP config built while it existed still names
   * this port, and a recovery onto a different one has to fire
   * `onPortChanged` for them.
   */
  let publishedPort: number | null = null;
  /**
   * Whether `<LIBI_HOME>/mcp-port` is this supervisor's: set when a publish
   * writes it, cleared by every drop. A port number alone is not identity.
   * After a drop another instance on the same home can publish the same
   * number, and the file naming it is then theirs.
   */
  let ownsPortFile = false;
  /**
   * True once the first launch gave up. Nothing was published then, but the
   * studio booted on, so ACP configs were built against a fallback URL; the
   * first recovery has to rebuild them (see `publish`).
   */
  let bootGaveUp = false;
  let state: "running" | "restarting" | "gave-up" | "stopped" = "running";
  const currentState = () => state;
  /**
   * False until the first launch has settled. Before that, the first-launch
   * flow owns relaunching (it re-picks once on a bind failure), so a
   * crash-restart timer armed by that first child's exit must not race it.
   */
  let booted = false;
  /**
   * True for the WHOLE of a user-driven restart, health check included.
   * `state` is back to `running` while the relaunch health-checks (the `exit`
   * handler only counts a failure in that state), so it cannot be the guard
   * against a second restart landing in that window and killing the child the
   * first one is waiting on — nor against the crash path relaunching in
   * parallel with it.
   */
  let userRestartInFlight = false;
  /**
   * Armed when a restarted child passes its health check; firing it forgives
   * the restarts spent so far. Without it a child that crashes once a week
   * eventually exhausts a budget meant for a child that cannot start at all.
   */
  let healthyResetTimer: ReturnType<typeof setTimeout> | undefined;
  const clearHealthyReset = () => {
    if (!healthyResetTimer) return;
    clearTimeout(healthyResetTimer);
    healthyResetTimer = undefined;
  };
  /** The backoff delay before a crash-path relaunch. */
  let crashRestartTimer: ReturnType<typeof setTimeout> | undefined;
  const clearCrashRestart = () => {
    if (!crashRestartTimer) return;
    clearTimeout(crashRestartTimer);
    crashRestartTimer = undefined;
  };

  /**
   * Children whose spawn failed: an `error` event, and no `exit` will follow.
   * Node happens to leave a negative `exitCode` on them too; this record does
   * not depend on that.
   */
  const spawnFailed = new WeakSet<ChildProcess>();
  /**
   * A child killed by a signal reports `exitCode: null` with `signalCode`
   * set, so `exitCode` alone reads a dead child as alive. A child that never
   * spawned is as gone as one that exited: nothing to health-check or kill.
   */
  const exited = (c: ChildProcess): boolean =>
    c.exitCode !== null || (c.signalCode ?? null) !== null || spawnFailed.has(c);

  /**
   * How a child that never became healthy actually ended, for the gave-up /
   * unhealthy message and log. Only meaningful once `exited(c)` is true — a
   * child still alive when its health window closes never ran anything down;
   * it simply ran out the clock, which is what the timeout wording (built by
   * the caller, not here) says instead.
   */
  const describeExit = (c: ChildProcess): string => {
    if (c.signalCode) return `exited before becoming healthy (signal ${c.signalCode})`;
    if (c.exitCode !== null) return `exited before becoming healthy (code ${c.exitCode})`;
    // A spawn failure (ENOENT, EACCES, ...): gone before it had a code or
    // signal to report.
    return "exited before becoming healthy";
  };

  /**
   * Write the port file for a child that just passed its health check on
   * `healthyPort`, and — when a different port had been published before —
   * notify `onPortChanged`, file first. EVERY successful health check goes
   * through here (first launch, crash-path restart, user restart), so the
   * published port is always the one a healthy child is actually on, whichever
   * path moved it.
   */
  const publish = (healthyPort: number): void => {
    try {
      fs.writeFileSync(portFile, String(healthyPort), "utf-8");
      ownsPortFile = true;
    } catch (err) {
      // The child is healthy; a discovery file that cannot be written is
      // worth a log line, not a failed launch. `handle.port` still answers.
      logger.warn({ tag: "mcp-http", op: "port_file_write_failed", port: healthyPort, portFile, err });
    }
    const previous = publishedPort;
    publishedPort = healthyPort;
    if ((previous !== null && previous !== healthyPort) || (previous === null && bootGaveUp)) {
      logger.info({ tag: "mcp-http", op: "port_changed", from: previous, to: healthyPort });
      deps.onPortChanged?.(healthyPort);
    }
  };

  /**
   * For a FIRST launch that gave up. Nothing of this supervisor's was ever
   * published, so a file already there is someone else's: an earlier run that
   * never cleaned up, or another libi on the same home whose aggregator is
   * live. Only the first kind may go, or `libi connect` and every client
   * reading the file lose that instance. It is removed when it does not name a
   * port, when it names `ownPort`, or when nothing listens on the port it
   * names, and not if it was rewritten while that was being probed.
   *
   * `ownPort` is the port the launch's child was still alive on when the
   * give-up killed it, with no other process heard answering there. A file
   * naming it is an earlier run's: a live endpoint on that port would have
   * kept the child from binding (it exits) or answered its `/healthz`. That
   * port is not probed. The kill has only just been sent and lands
   * asynchronously (`taskkill` on Windows, and the listener may be a
   * grandchild whose exit is never observed here), so the port can still
   * read as held by the dying child, for longer than any bounded wait covers
   * on a slow cold start.
   */
  const dropLeftoverPortFile = async (ownPort: number | null): Promise<void> => {
    const read = (): string | null => {
      try {
        return fs.readFileSync(portFile, "utf-8");
      } catch {
        return null;
      }
    };
    const found = read();
    if (found === null) return;
    const named = parseMcpPortEnv(found.trim());
    if (named !== null && named !== ownPort && !(await portIsFree(named).catch(() => false))) {
      logger.info(
        { tag: "mcp-http", op: "port_file_kept", port: named, portFile },
        "mcp-port names a port in use, most likely another libi instance's endpoint; leaving it",
      );
      return;
    }
    if (read() !== found) return;
    try {
      fs.unlinkSync(portFile);
    } catch {
      /* already gone */
    }
  };

  /**
   * Remove the port file only while this supervisor owns it: it wrote the file
   * and has not dropped it since, and the file still names the port it wrote.
   * Every drop gives ownership up, whatever it found. From then on another libi
   * on the same home may publish its own aggregator, on any port, this one's
   * old number included, and removing that file would strand its clients.
   */
  const dropOwnPortFile = () => {
    if (!ownsPortFile) return;
    ownsPortFile = false;
    removePortFileIfOwned(portFile, publishedPort);
  };

  /** Each child's last lines of output, raw, plus the env it was launched with (for scrubbing). */
  const outputs = new WeakMap<ChildProcess, { tail: string[]; env: Record<string, string> }>();
  /** Children whose output has been logged already: a failed relaunch that then spends the last of the budget reports once. */
  const outputReported = new WeakSet<ChildProcess>();

  /**
   * The child's own last words, for a launch that failed: logged at `warn`
   * (once per child, scrubbed) and returned in short form for an error
   * message, or "" when it printed nothing. Without this the only trace of
   * why a child never came up was a `debug` line per chunk, below the level
   * a field log is written at.
   */
  const reportOutput = (c: ChildProcess, launchedPort: number, reason: "unhealthy" | "gave-up"): string => {
    const captured = outputs.get(c);
    const lines = captured ? scrubChildOutput(captured.tail, captured.env) : [];
    if (!outputReported.has(c)) {
      outputReported.add(c);
      logger.warn(
        { tag: "mcp-http", op: "child_unhealthy_output", pid: c.pid, port: launchedPort, reason, lines },
        lines.length > 0
          ? "last output from the MCP endpoint process before it failed"
          : "the MCP endpoint process printed nothing before it failed",
      );
    }
    if (lines.length === 0) return "";
    return `; last output: ${lines.slice(-ERROR_TAIL_LINES).join(" | ")}`;
  };

  /** The token each child was launched with; its `/healthz` has to echo it. */
  const healthTokens = new WeakMap<ChildProcess, string>();
  /** Children a foreign `/healthz` answer has been logged for already. */
  const foreignAnswerReported = new WeakSet<ChildProcess>();
  /**
   * Something answered `/healthz` on `launchedPort` without `c`'s token: most
   * likely another libi instance's aggregator. Logged once per child, and
   * never with either token.
   */
  const reportForeignAnswer = (c: ChildProcess, launchedPort: number): void => {
    if (foreignAnswerReported.has(c)) return;
    foreignAnswerReported.add(c);
    logger.warn(
      { tag: "mcp-http", op: "health_foreign_answer", pid: c.pid, port: launchedPort },
      "a /healthz answer on this port did not come from the child just launched; still waiting for it",
    );
  };

  /**
   * Poll `/healthz` on `launchedPort` until `c` itself answers, `c` dies, or
   * the deadline passes. EVERY launch goes through this — a restarted child
   * that comes up wedged is no more useful than one that never started. The
   * port is the one `c` was launched on, never the shared `port`, which a
   * later relaunch may already have moved. Only an answer carrying the token
   * `c` was launched with counts, and `c` must still be alive when it arrives.
   */
  const waitHealthy = async (
    c: ChildProcess,
    launchedPort: number,
    timeoutMs: number = healthTimeoutMs,
  ): Promise<boolean> => {
    const token = healthTokens.get(c);
    const deadline = Date.now() + timeoutMs;
    if (exited(c)) return false;
    // An attempt still out when the child exits is abandoned then, rather than
    // at its own timeout: whatever answers now is not this child, and a child
    // that could not bind is reported as soon as it is gone.
    const childGone = new AbortController();
    const onGone = () => childGone.abort();
    c.once("exit", onGone);
    c.once("error", onGone);
    try {
      while (Date.now() < deadline) {
        // Each attempt ends on its own, never later than the deadline. A
        // listener that accepts and never answers (a wedged process, another
        // program on a pinned port) otherwise keeps this await pending until
        // the HTTP client's own headers timeout, minutes past the window, and
        // a first launch holds the whole boot for that long.
        const attempt = AbortSignal.any([
          AbortSignal.timeout(Math.max(1, Math.min(healthAttemptTimeoutMs, deadline - Date.now()))),
          childGone.signal,
        ]);
        try {
          const r = await doFetch(`http://127.0.0.1:${launchedPort}/healthz`, { signal: attempt });
          // A child that died while the request was out did not send the answer.
          if (exited(c)) return false;
          if (r.ok) {
            const echoed = await echoedHealthToken(r);
            if (token !== undefined && echoed === token && !exited(c)) return true;
            // A body cut off by the attempt's own end says nothing about who
            // was answering, so it is not counted as someone else's endpoint.
            if (!attempt.aborted && !exited(c)) reportForeignAnswer(c, launchedPort);
          }
        } catch {
          /* not up yet — retry until the deadline */
        }
        if (exited(c)) return false;
        await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
      }
      return false;
    } finally {
      c.removeListener("exit", onGone);
      c.removeListener("error", onGone);
    }
  };

  const launch = (launchPort: number): ChildProcess => {
    const e = entry();
    const leadsGroup = !isWindows() && e.mode !== "compiled";
    // Handed to the child with the rest of its environment, so it is also
    // masked in the child's captured output like any secret-named value.
    const healthToken = newHealthToken();
    const childEnv: Record<string, string> = {
      ...e.env,
      LIBI_MCP_PORT: String(launchPort),
      // After `e.env`, which inherits this process's environment: the parent's
      // own port must win over anything inherited.
      [LIBI_SERVER_PORT_ENV]: serverPort(),
      [MCP_HEALTH_TOKEN_ENV]: healthToken,
      // Stays in the child's environment for its whole life; the token above does not.
      [MCP_SUPERVISED_ENV]: "1",
    };
    const opts: SpawnOptions = {
      // `buildLibiHttpEntry` already returns a complete environment. The
      // double cast follows the repo's established pattern (see
      // lib/uv-env/spawn-env.ts, lib/runtime/runtime-install.ts): Next's
      // ambient augmentation makes `NODE_ENV` a required literal union, which
      // a `Record<string, string>` can never satisfy structurally.
      env: childEnv as unknown as NodeJS.ProcessEnv,
      // A process group of its own on POSIX when the entry is tsx's wrapper,
      // so `killTree` reaches the grandchild that is the real server (see
      // `signalChildTree`). The compiled entry is one process and stays in
      // libi's group, still sharing a terminal's signals with it.
      detached: leadsGroup,
      // stdin is the child's lifeline to this process, not an input: nothing
      // is ever written to it, and a supervised child exits when it closes
      // (`mcp/http/index.ts`). tsx's grandchild inherits the same pipe. The
      // write end is close-on-exec, so no other process libi spawns holds it,
      // and it closes however this process ends, a SIGKILL included, which no
      // signal handler or `exit` hook can promise. A detached child is outside
      // every signal aimed at libi's own group (a closed terminal, a test
      // runner's group SIGKILL); this is what still ends it then.
      //
      // On Windows the stdin pipe is not what usually does this: Node/libuv
      // places a non-detached child (this one, and the server process that
      // spawns it) in a job object that is closed together with its parent,
      // which ends the whole tree on its own. QA observed a force-killed libi
      // server take its aggregator down within a few hundred milliseconds,
      // with nothing logged that would come from the aggregator noticing its
      // stdin close first. The pipe closing is still what ends a hand-run or
      // otherwise-orphaned child there — it just isn't the one that fires
      // when the server that owns this child is killed.
      stdio: ["pipe", "pipe", "pipe"],
    };
    const c = spawn(e.command, e.args, opts);
    healthTokens.set(c, healthToken);
    // Not a reason for libi to stay up: the studio's own server keeps the
    // process alive, and whatever ends libi stops this child on the way out.
    for (const h of [c, c.stdin, c.stdout, c.stderr]) unrefHandle(h);
    // Nothing is ever written, so the only error possible is on a pipe whose
    // reader is gone, and that must not be an uncaught exception in libi.
    c.stdin?.on("error", () => {});
    // Both pipes are drained. The entry writes nothing to stdout today, but an
    // undrained pipe fills its buffer and wedges the child. The last lines of
    // both are kept for `reportOutput`.
    const tail: string[] = [];
    outputs.set(c, { tail, env: childEnv });
    const capture = (stream: "stdout" | "stderr") => (d: Buffer) => {
      const text = d.toString();
      logger.debug({
        tag: "mcp-http",
        op: `child_${stream}`,
        line: scrubChildOutput([text.trimEnd()], childEnv)[0],
      });
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (!line) continue;
        tail.push(`${stream === "stdout" ? "[stdout] " : ""}${line.slice(0, OUTPUT_LINE_MAX)}`);
        if (tail.length > OUTPUT_TAIL_LINES) tail.shift();
      }
    };
    c.stdout?.on("data", capture("stdout"));
    c.stderr?.on("data", capture("stderr"));
    // `exit` and a spawn `error` both mean this child is gone, and a child can
    // emit both: whichever arrives first is the one accounted for.
    let accounted = false;
    const gone = (
      cause: "exit" | "spawn-error",
      code: number | string | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (accounted) return;
      accounted = true;
      // A child that has already been replaced is not ours to account for. A
      // killed child can exit well after its replacement is up (its SIGTERM
      // handler closes sessions first), and counting that as the new child's
      // crash would spend budget and schedule a relaunch over a healthy child.
      if (child !== c) return;
      // A child that is gone can no longer earn its budget back.
      clearHealthyReset();
      // `stop()` and a user restart both latch the state before killing, so
      // the exit they cause never looks like a crash.
      if (state !== "running") return;
      // A closed console reaches its processes one at a time, newest first, and
      // Windows waits on each one's handler before moving on, so this child is
      // gone before the server hears the same close. Its exit is not a crash
      // yet: the relaunch (or the give-up, with the budget spent) waits long
      // enough for the server's own shutdown to latch `stopped` and cancel it.
      // If no shutdown comes, the code came from something else, and the exit
      // is accounted for exactly as a crash is.
      const consoleClosed =
        cause === "exit" &&
        isWindows() &&
        (code === STATUS_CONTROL_C_EXIT || code === STATUS_CONTROL_C_EXIT_SIGNED);
      if (consoleClosed) {
        logger.info({ tag: "mcp-http", op: "child_console_closed", code, restarts });
        clearCrashRestart();
        crashRestartTimer = setTimeout(() => {
          crashRestartTimer = undefined;
          if (state !== "running" || child !== c) return;
          crashed(code);
        }, CONSOLE_CLOSE_GRACE_MS);
        crashRestartTimer.unref();
        return;
      }
      // A spawn failure was already logged, with its code, when it arrived.
      if (cause === "exit") logger.warn({ tag: "mcp-http", op: "child_exit", code, signal, restarts });
      crashed(code);
    };
    /** Spend the restart budget on this child's death: relaunch after backoff, or give up. */
    const crashed = (code: number | string | null): void => {
      if (restarts >= maxRestarts) {
        state = "gave-up";
        // Nothing is listening on `port` any more, so the discovery file must
        // go with the child — a stale `mcp-port` sends every MCP client at a
        // dead socket and makes the aggregator look broken rather than absent.
        dropOwnPortFile();
        const err = new Error(
          // `launchPort`, not the shared `port`: a later pick may have moved it.
          `MCP aggregator exited ${restarts + 1} times (last code ${code})${reportOutput(c, launchPort, "gave-up")}`,
        );
        logger.error({ tag: "mcp-http", op: "child_gave_up", err });
        deps.onGaveUp?.(err);
        return;
      }
      const delay = restartDelayMs * 2 ** restarts;
      restarts++;
      clearCrashRestart();
      const fire = () => {
        crashRestartTimer = undefined;
        // Stale unless `c` is still the current, running child: something
        // else (stop, a user restart, the first-launch re-pick) took over.
        if (!booted || state !== "running" || child !== c) return;
        // Only reachable when `c` is a user restart's own relaunch that died
        // during its health check: that restart is about to reject, and this
        // relaunch must still happen once it has — not be dropped.
        if (userRestartInFlight) {
          crashRestartTimer = setTimeout(fire, HEALTH_POLL_MS);
          crashRestartTimer.unref();
          return;
        }
        void restart(c).catch((err: unknown) => crashRestartFailed(c, err));
      };
      crashRestartTimer = setTimeout(fire, delay);
      crashRestartTimer.unref();
    };
    c.on("exit", (code, signal) => {
      // Whatever outlives a child that led its own group (tsx's grandchild,
      // when something killed the wrapper alone, or a process the server
      // started) is signalled now, whoever caused the exit. Now, and not later
      // from `stop()`: at this moment the group id still names only that
      // group, because a group with a live member keeps its id and the leader
      // was reaped just now. A group signal sent long afterwards, at a quit
      // following a gave-up say, could reach an unrelated process that reused
      // the id. The closed stdin reaches the same survivors; this does not
      // depend on them watching it.
      if (leadsGroup && c.pid !== undefined) signalGroup(c.pid, "SIGTERM");
      gone("exit", code, signal);
    });
    c.on("error", (err: NodeJS.ErrnoException) => {
      // Node also emits `error` for a signal it could not deliver. That child is
      // still running, and relaunching beside it would collide on its port, so
      // it is logged and left to whoever sent the signal.
      if (err.syscall === "kill") {
        logger.warn({ tag: "mcp-http", op: "child_kill_error", pid: c.pid, code: err.code, current: child === c });
        return;
      }
      // Otherwise the child never spawned (this entry opens no IPC channel, the
      // only other source). The code only: the error's other fields describe
      // the spawn, and nothing from its environment belongs in a log.
      logger.warn({
        tag: "mcp-http",
        op: "child_spawn_error",
        code: err.code,
        current: child === c,
        restarts,
      });
      spawnFailed.add(c);
      gone("spawn-error", err.code ?? null, null);
    });
    return c;
  };

  /**
   * The port the next launch should use: the current one while it is free,
   * else whatever the picker says now — or `null` when `stillOwner()` stopped
   * holding after one of the awaits, in which case nothing may be changed.
   *
   * The default is 3457 for everyone, so two libi instances starting within a
   * second of each other (canonical + worktree, desktop app + `npx`) both pick
   * it and the loser's child exits on `EADDRINUSE`. Relaunching on the same
   * port loses again, forever, until the restart budget runs out — so re-run
   * the picker, which now probes a port the winner is holding and falls
   * through to the next candidate.
   *
   * `releaseWaitMs` keeps re-probing the current port for that long before
   * re-picking. A user restart passes a short bound: the port it probes was
   * held by the child it just killed, so "taken" at first is usually that
   * child's socket still closing, not someone else. Moving the port on that
   * would break every CLI registration naming it for nothing.
   *
   * Only `port` changes here. Publishing waits for health (see `publish`).
   */
  const repickIfTaken = async (
    stillOwner: () => boolean,
    releaseWaitMs: number,
    reason: "bind-failed" | "crash" | "restart",
  ): Promise<number | null> => {
    const releaseDeadline = Date.now() + releaseWaitMs;
    for (;;) {
      const free = await portIsFree(port);
      if (!stillOwner()) return null;
      if (free) return port;
      if (Date.now() >= releaseDeadline) break;
      await new Promise((r) => setTimeout(r, PORT_RELEASE_POLL_MS));
      if (!stillOwner()) return null;
    }
    const next = await pickPort();
    if (!stillOwner()) return null;
    // A pinned `LIBI_MCP_PORT` re-picks to itself: staying and failing loudly
    // is what someone who pinned a port asked for.
    if (next !== port) {
      logger.warn({ tag: "mcp-http", op: "port_repicked", from: port, to: next, reason }, "aggregator port taken");
      port = next;
    }
    return port;
  };

  /**
   * SIGTERM `c`'s process tree and wait for `c` to exit, escalating to SIGKILL after
   * `STOP_GRACE_MS` and then waiting up to `KILL_EXIT_WAIT_MS` for the exit
   * that causes — until the process is gone its listening socket may still
   * hold the port. Resolves `false` when no exit was seen at all. The caller
   * latches `state` first, so the exit this causes is never counted as a crash.
   */
  const killChild = (c: ChildProcess): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (exited(c)) {
        resolve(true);
        return;
      }
      let afterKill: ReturnType<typeof setTimeout> | undefined;
      const onExit = () => {
        clearTimeout(grace);
        if (afterKill) clearTimeout(afterKill);
        resolve(true);
      };
      const grace = setTimeout(() => {
        killTree(c, "SIGKILL");
        afterKill = setTimeout(() => {
          c.off("exit", onExit);
          logger.warn({ tag: "mcp-http", op: "child_kill_no_exit", pid: c.pid, waitedMs: KILL_EXIT_WAIT_MS });
          resolve(false);
        }, KILL_EXIT_WAIT_MS);
        afterKill.unref();
      }, STOP_GRACE_MS);
      grace.unref();
      c.once("exit", onExit);
      killTree(c, "SIGTERM");
    });

  /** Arm the timer that forgives the restart budget once `c` stays up. */
  const armHealthyReset = () => {
    clearHealthyReset();
    healthyResetTimer = setTimeout(() => {
      healthyResetTimer = undefined;
      restarts = 0;
      logger.info({ tag: "mcp-http", op: "child_restart_budget_reset", port, healthyResetMs });
    }, healthyResetMs);
    healthyResetTimer.unref();
  };

  /**
   * Relaunch after `crashed` died, and health-check the replacement exactly as
   * the first launch was. An unhealthy restart is killed and left to the
   * `exit` handler above, so it counts against `maxRestarts` like any other
   * failure instead of being silently accepted as a live aggregator.
   *
   * After EVERY await it re-checks that it still owns the relaunch: running,
   * the child is still the one it is replacing (then, its own replacement),
   * and no user restart has started. Whoever took over also took the child;
   * spawning anyway would leave one of the two running unsupervised.
   */
  const restart = async (crashed: ChildProcess): Promise<void> => {
    const owns = (c: ChildProcess) => state === "running" && child === c && !userRestartInFlight;
    // Start from the port consumers were last told about, as a user restart
    // does. After an earlier relaunch re-picked and then failed, `port` names a
    // port nothing was ever published on; probing it would move the endpoint
    // even once the published port is free again.
    if (owns(crashed) && publishedPort !== null) port = publishedPort;
    const launchPort = await repickIfTaken(() => owns(crashed), 0, "crash");
    if (launchPort === null || !owns(crashed)) return;
    const c = launch(launchPort);
    child = c;
    logger.info({ tag: "mcp-http", op: "child_restart", pid: c.pid, port: launchPort, restarts });
    const healthy = await waitHealthy(c, launchPort);
    if (!owns(c)) return;
    if (!healthy) {
      logger.warn({ tag: "mcp-http", op: "child_restart_unhealthy", pid: c.pid, port: launchPort, restarts });
      reportOutput(c, launchPort, "unhealthy");
      // The kill's own `exit` does the accounting; if it already exited on its
      // own, that exit has been accounted for already.
      if (!exited(c)) killTree(c, "SIGKILL");
      return;
    }
    publish(launchPort);
    logger.info({ tag: "mcp-http", op: "child_restart_ready", pid: c.pid, port: launchPort, restarts });
    armHealthyReset();
  };

  /**
   * A crash-path relaunch that threw — the port picker rejected, or resolving
   * the launch entry failed — before a replacement child existed. Nothing is
   * listening any more, so it ends where a failed user restart does: logged,
   * `gave-up`, no port file, and a later user restart recovers it. Only logged
   * when something else (`stop()`, a user restart) has taken over the child.
   */
  const crashRestartFailed = (crashed: ChildProcess, err: unknown): void => {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error({ tag: "mcp-http", op: "child_crash_restart_failed", port, restarts, err: error });
    if (state !== "running" || child !== crashed || userRestartInFlight) return;
    state = "gave-up";
    clearHealthyReset();
    clearCrashRestart();
    // `publishedPort` stays: see its declaration.
    dropOwnPortFile();
    deps.onGaveUp?.(error);
  };

  /**
   * User-driven restart (the Restart button on the libi MCP tab). It differs
   * from the crash path above in three ways:
   *   - it may run from `gave-up`, and resets the budget, so it also recovers
   *     that state;
   *   - it prefers the SAME port — the one last published — because a
   *     registration in the user's own CLI config names it: it waits for the
   *     old child to exit and re-probes briefly, and re-picks only when the
   *     port is still taken after that;
   *   - it REJECTS on an unhealthy relaunch instead of silently counting it.
   * It never relaunches libi itself.
   */
  const userRestart = async (): Promise<void> => {
    if (state === "stopped") throw new Error("MCP aggregator is stopped; restart libi instead");
    // The first launch owns relaunching until it settles (see `booted`).
    if (!booted) throw new Error("MCP aggregator is still starting");
    if (state === "restarting" || userRestartInFlight) {
      throw new Error("MCP aggregator is already restarting");
    }
    userRestartInFlight = true;
    try {
      state = "restarting";
      clearHealthyReset();
      // A relaunch this restart is about to perform itself.
      clearCrashRestart();
      restarts = 0;
      // Same rule as the crash path: `stop()` can land during ANY await below,
      // and a shutdown must not resurrect the child (file header).
      const restarting = () => state === "restarting";
      const stoppedDuring = () => new Error("MCP aggregator was stopped during restart");
      let c: ChildProcess;
      let launchPort: number;
      try {
        const old = child;
        if (old && !exited(old)) await killChild(old);
        if (!restarting()) throw stoppedDuring();
        // Start from the port consumers were last told about. A launch that
        // re-picked and then failed leaves `port` on a port no URL names; a
        // restart that kept it would move the endpoint even once the
        // published port is free again.
        if (publishedPort !== null) {
          port = publishedPort;
        } else if (bootGaveUp) {
          // Nothing was ever published: the first launch gave up on whatever
          // port it ended on, possibly a fallback it moved to while the
          // default was busy. No URL outside this process names that port, and
          // the default may be free again, so ask the picker afresh.
          const picked = await pickPort();
          if (!restarting()) throw stoppedDuring();
          port = picked;
        }
        const chosen = await repickIfTaken(restarting, PORT_RELEASE_WAIT_MS, "restart");
        if (chosen === null) throw stoppedDuring();
        launchPort = chosen;
        // Launch, then flip to `running` with no await in between: the new
        // child's `exit` handler counts failures only in `running`, and a
        // synchronous spawn failure leaves `restarting` for the catch below.
        c = launch(launchPort);
        child = c;
        state = "running";
      } catch (err) {
        // `stop()` won: it already latched `stopped`, killed what was running
        // and dropped the port file. Nothing to undo.
        if (state !== "restarting") throw err;
        // Anything else failed after the old child was killed and before a new
        // one existed, so nothing is listening. Leaving `restarting` behind
        // would refuse every later restart for the life of the process;
        // `gave-up` is the truthful state and the one a restart recovers from.
        // `publishedPort` stays: see its declaration.
        state = "gave-up";
        dropOwnPortFile();
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error({ tag: "mcp-http", op: "child_user_restart_failed", port, err: error });
        deps.onGaveUp?.(error);
        throw error;
      }
      logger.info({ tag: "mcp-http", op: "child_user_restart", pid: c.pid, port: launchPort });
      const healthy = await waitHealthy(c, launchPort);
      // Read through a function: TypeScript narrows `state` to the `running`
      // assigned above and cannot see `stop()` changing it across the await.
      const settled = currentState();
      if (settled === "stopped") throw stoppedDuring();
      // A relaunch that died during its health check (an exit, or a spawn that
      // failed) was already counted by its own handler, which may have spent
      // the last of the budget and left `gave-up`. That is this restart
      // failing, not being superseded.
      const died = child === c && exited(c);
      if (child !== c || (settled !== "running" && !died)) {
        throw new Error("MCP aggregator restart was superseded");
      }
      if (!healthy || died) {
        // A relaunch that had already exited did not run out its window —
        // the deadline never mattered, so it gets what it actually did
        // (its exit code or signal, when known) instead of the timeout
        // wording, which is reserved for one still alive when the window
        // closed.
        const reason = died ? describeExit(c) : `did not become healthy within ${healthTimeoutMs}ms`;
        logger.warn({
          tag: "mcp-http",
          op: "child_user_restart_unhealthy",
          pid: c.pid,
          port: launchPort,
          exited: died,
        });
        const output = reportOutput(c, launchPort, "unhealthy");
        // Counted like any other failed launch: the kill's `exit` runs the
        // standard handler in `running`.
        if (!exited(c)) killTree(c, "SIGKILL");
        throw new Error(`MCP aggregator on port ${launchPort} ${reason}${output}`);
      }
      publish(launchPort);
      logger.info({ tag: "mcp-http", op: "child_user_restart_ready", pid: c.pid, port: launchPort });
    } finally {
      userRestartInFlight = false;
    }
  };

  const handle: McpHttpChildHandle = {
    get port() {
      return port;
    },
    get advertisedPort() {
      return publishedPort ?? port;
    },
    get publishedPort() {
      return publishedPort;
    },
    ownsHealthAnswer: (body: unknown): boolean => {
      const c = child;
      if (!c || exited(c)) return false;
      const token = healthTokens.get(c);
      const echoed =
        typeof body === "object" && body !== null ? (body as { healthToken?: unknown }).healthToken : undefined;
      return token !== undefined && echoed === token;
    },
    // `state` is `running` again while a user restart health-checks its
    // relaunch (the `exit` handler depends on that); the handle reports the
    // restart as still in progress until it has settled.
    status: () => (state === "running" && userRestartInFlight ? "restarting" : state),
    restart: userRestart,
    stop: async () => {
      state = "stopped";
      clearHealthyReset();
      clearCrashRestart();
      dropOwnPortFile();
      const c = child;
      if (!c || exited(c)) return;
      await killChild(c);
    },
  };

  const first = launch(port);
  child = first;
  logger.info({ tag: "mcp-http", op: "child_spawn", pid: first.pid, port });
  // Before the health wait, not after it: see `McpHttpChildDeps.onHandle`.
  deps.onHandle?.(handle);

  let healthy = await waitHealthy(first, port, firstHealthTimeoutMs);
  // An exit before health is a child that could not bind, not a wedged one —
  // the port is the suspect, so re-pick and try once on the new one. A child
  // that is still ALIVE but silent is a real hang and is not retried here. A
  // child that failed to SPAWN left the port free, so the probe finds nothing
  // to move and the launch ends gave-up below.
  if (!healthy && exited(first)) {
    try {
      const previous = port;
      const next = await repickIfTaken(() => state === "running" && child === first, 0, "bind-failed");
      if (next !== null && next !== previous) {
        clearCrashRestart();
        child = launch(next);
        logger.info({ tag: "mcp-http", op: "child_spawn", pid: child.pid, port: next, repicked: true });
        healthy = await waitHealthy(child, next, firstHealthTimeoutMs);
      }
    } catch (err) {
      // The handle is already out, so this launch has to end in a state it can
      // be recovered from rather than reject: gave-up, below.
      logger.warn({ tag: "mcp-http", op: "child_repick_failed", port, err });
    }
  }
  // A first launch that heard another process answer on its port, and never
  // its own child, ends gave-up below with nothing published, so every URL
  // this process hands out meanwhile names `port`. That port is known to be
  // someone else's endpoint, most likely another libi instance's, whose tools
  // an in-app agent would then call against that instance's home and
  // database. Take a port nothing answers on instead; a restart re-picks anyway.
  const launchedPort = port;
  if (!healthy && currentState() === "running" && child !== null && foreignAnswerReported.has(child)) {
    try {
      const picked = await pickPort();
      if (currentState() === "running" && picked !== port) {
        logger.warn(
          { tag: "mcp-http", op: "port_repicked", from: port, to: picked, reason: "foreign-answer" },
          "another process answers on the aggregator port",
        );
        port = picked;
      }
    } catch (err) {
      logger.warn({ tag: "mcp-http", op: "child_repick_failed", port, err });
    }
  }
  booted = true;

  // `stop()` landed inside the health window (libi quit while the child was
  // still coming up). It has killed the child and removed any port file this
  // supervisor published; nothing may be published or given up on now.
  if (currentState() === "stopped") return handle;

  if (!healthy) {
    // Latched before the kill, so its `exit` is not counted as a crash (and a
    // crash timer the failed child armed finds nothing to relaunch). The
    // handle is still returned: `gave-up` is exactly the state `restart()`
    // recovers (nothing was published, so it asks the picker afresh).
    state = "gave-up";
    bootGaveUp = true;
    clearCrashRestart();
    const failed = child;
    const failedAlreadyExited = exited(failed);
    const output = reportOutput(failed, launchedPort, "unhealthy");
    if (!failedAlreadyExited) killTree(failed, "SIGKILL");
    // Nothing of ours is listening: a port file left by an earlier run must
    // not send clients at that socket. One another instance's live endpoint
    // is named in stays. A child still alive here, with nobody else heard on
    // its port, was the one holding that port.
    await dropLeftoverPortFile(!failedAlreadyExited && !foreignAnswerReported.has(failed) ? launchedPort : null);
    // The handle has been out since the spawn, so a `stop()` or `restart()`
    // may have landed during that probe. Neither is a give-up to report.
    if (currentState() !== "gave-up") return handle;
    // A child that had already exited did not run out the 30 s (or pinned)
    // window — it never got that far, so naming the window would misdescribe
    // what happened. That wording is for a child still alive when the window
    // closed; an already-exited one gets what it actually did, with its exit
    // code or signal when known.
    const reason = failedAlreadyExited
      ? describeExit(failed)
      : `did not become healthy within ${firstHealthTimeoutMs}ms`;
    const err = new Error(`MCP aggregator on port ${launchedPort} ${reason}${output}`);
    logger.error({
      tag: "mcp-http",
      op: "child_start_gave_up",
      port: launchedPort,
      exited: failedAlreadyExited,
      err,
    });
    deps.onGaveUp?.(err);
    return handle;
  }

  // Only now, with a health-checked listener behind it, is the port file safe
  // to publish. Nothing was published before, so this never notifies — no ACP
  // config holds a URL from this process yet, and Category B's end-of-boot
  // `invalidateMcpConfig` refreshes the cache anyway.
  publish(port);
  // A first-launch re-pick above runs the STANDARD `exit` handler on the
  // child that failed to bind (while it was still `child`), which counts it as
  // a restart. That is not a restart recovering from a crash — it is the
  // normal "the default port is taken" dance — so it must not cost budget the
  // aggregator has not actually earned back yet.
  restarts = 0;
  clearHealthyReset();
  logger.info({ tag: "mcp-http", op: "child_ready", port, portFile });

  return handle;
}
