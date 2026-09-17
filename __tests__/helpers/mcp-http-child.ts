import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A port the OS says is free right now: bind `0` on loopback, read what the
 * kernel handed out, release it.
 *
 * Use this for anything that has to `listen` on a fixed port — never a random
 * number in a range. A range wide enough to look safe still collides (two
 * parallel vitest workers, a dev server, a second checkout), and the failure
 * lands as `EADDRINUSE` inside an unrelated assertion, which reads as a flake
 * in whatever the test was actually about. Mirrors `freePort()` in
 * `lib/server/lifecycle/mcp-http-child.ts`.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/**
 * Poll `predicate` until it returns true, or throw naming what never became
 * true. Use this instead of a flat `setTimeout` wait for any assertion that
 * depends on async server-side state (a notification, a session going away) —
 * a fixed sleep is either a slow test or a flaky one, this is neither.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const { timeoutMs = 5_000, intervalMs = 50, message = "condition" } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${message} never became true`);
    }
    await sleep(intervalMs);
  }
}

/**
 * Ask the aggregator to shut down, then confirm it is actually gone.
 *
 * `mcp/http/index.ts` installs a SIGTERM handler that closes every open
 * session (each holds an in-process libi `McpServer`) before exiting. A bare
 * SIGKILL on the aggregator skips that handler entirely, so SIGTERM-and-wait
 * is the primary path; SIGKILL is only a fallback for a wedged aggregator,
 * and takes the process group with it as a last resort.
 */
async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timedOut = await Promise.race([exited.then(() => false), sleep(5_000).then(() => true)]);
  if (!timedOut) return;
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    /* group already gone */
  }
  child.kill("SIGKILL");
  await Promise.race([exited, sleep(2_000)]);
}

/**
 * The pid of a descendant of `rootPid` whose command line contains `match`.
 *
 * A test that wants to find (or kill) something the aggregator spawned has to
 * walk down from its OWN child rather than pattern-match every process on the
 * machine — a bare `pgrep -f` would happily hit a libi the developer is
 * running in another window. tsx may re-exec in between, hence the walk.
 */
export function findDescendantPid(rootPid: number, match: string): number | null {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));
  const children = new Map<number, typeof rows>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) {
      if (child.args.includes(match)) return child.pid;
      queue.push(child.pid);
    }
  }
  return null;
}

export interface SpawnedMcpHttpChild {
  kill(): Promise<void>;
  baseUrl: string;
  /** The tsx wrapper's pid; the aggregator itself is its descendant (`findDescendantPid`). */
  pid: number;
  /**
   * Close the write end of the child's stdin, as the death of a supervising
   * libi server would. Only meaningful with `stdin: "pipe"`.
   */
  closeStdin(): void;
  /** Whether the wrapper process has exited. */
  exited(): boolean;
}

export async function spawnMcpHttpChild(opts: {
  libiHome: string;
  port: number;
  env?: Record<string, string>;
  /**
   * `"ignore"` (default) puts stdin at /dev/null, the shape of a run by hand
   * under a service manager. `"pipe"` gives it the pipe a supervisor holds.
   */
  stdin?: "ignore" | "pipe";
}): Promise<SpawnedMcpHttpChild> {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      path.join(ROOT, "node_modules/tsx/dist/cli.mjs"),
      "--tsconfig",
      path.join(ROOT, "tsconfig.json"),
      path.join(ROOT, "mcp/http/index.ts"),
    ],
    {
      stdio: [opts.stdin ?? "ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env, LIBI_HOME: opts.libiHome, LIBI_MCP_PORT: String(opts.port) },
      detached: true,
    },
  );
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const baseUrl = `http://127.0.0.1:${opts.port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/healthz`);
      if (r.ok) {
        return {
          kill: () => terminate(child),
          baseUrl,
          pid: child.pid!,
          closeStdin: () => child.stdin?.end(),
          exited: () => child.exitCode !== null || child.signalCode !== null,
        };
      }
    } catch {
      /* not yet listening */
    }
    if (child.exitCode !== null) {
      throw new Error(`aggregator exited ${child.exitCode}: ${stderr.slice(-1500)}`);
    }
    await sleep(150);
  }
  await terminate(child);
  throw new Error(`aggregator never became healthy: ${stderr.slice(-1500)}`);
}
