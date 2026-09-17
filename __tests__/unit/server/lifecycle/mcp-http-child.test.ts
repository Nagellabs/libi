/**
 * The lifecycle owns the HTTP MCP aggregator child.
 *
 * Three properties are load-bearing and easy to break silently:
 *   1. the child is spawned with the chosen port, and the port file is
 *      published ONLY after `/healthz` answers — a port file written early
 *      points every MCP client at a socket that is not listening yet;
 *   2. an unexpected exit is restarted with backoff, but only a bounded
 *      number of times, so a child that cannot start does not spin forever;
 *   3. a child that never becomes healthy is killed and the failure is
 *      surfaced, rather than leaving an orphan behind — on EVERY launch, not
 *      just the first, and a restart that stays healthy earns its budget back.
 *
 * All of them are exercised with fake children — the real child is covered by
 * `mcp-http-aggregator.test.ts` and by booting dev.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  startMcpHttpChild as startSupervisor,
  pickMcpHttpPort,
  signalChildTree,
  taskkillPath,
  type McpHttpChildDeps,
  type McpHttpChildHandle,
} from "@/lib/server/lifecycle/mcp-http-child";
import { DEFAULT_MCP_PORT } from "@/lib/libi-home";
import { serverLogger } from "@/lib/logger";

/** The token every fake child's `/healthz` echoes, and the body a healthy fake answers with. */
const TEST_HEALTH_TOKEN = "test-health-token";
const HEALTHY_BODY = JSON.stringify({ ok: true, healthToken: TEST_HEALTH_TOKEN });

/**
 * The supervisor with the two seams a fake child needs: a fixed health token
 * its fake `/healthz` can echo, and signals delivered to the fake's own `kill`
 * rather than to a real process group named by its made-up pid. The tests of
 * those two seams call `startSupervisor` directly.
 */
function startMcpHttpChild(deps: McpHttpChildDeps = {}): Promise<McpHttpChildHandle> {
  return startSupervisor({
    healthToken: () => TEST_HEALTH_TOKEN,
    killTree: (c, signal) => {
      c.kill(signal);
    },
    signalGroup: () => {},
    ...deps,
  });
}

function fakeChild() {
  const c = new EventEmitter() as EventEmitter & {
    pid: number;
    kill: ReturnType<typeof vi.fn>;
    stderr: EventEmitter;
    stdout: EventEmitter;
    exitCode: number | null;
    signalCode?: NodeJS.Signals | null;
  };
  c.pid = 4242;
  c.kill = vi.fn(() => {
    c.exitCode = 0;
    c.emit("exit", 0, null);
    return true;
  });
  c.stderr = new EventEmitter();
  c.stdout = new EventEmitter();
  c.exitCode = null;
  return c;
}

/** Poll until `predicate` holds — restart timing is real, not fake. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Directories `tmpPortFile` made; every one is removed after its test. */
const tmpDirs: string[] = [];

function tmpPortFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpport-"));
  tmpDirs.push(dir);
  return path.join(dir, "mcp-port");
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A promise plus its resolver, and a second promise that settles once something awaits it. */
function gate<T>() {
  let release!: (v: T) => void;
  let markEntered!: () => void;
  const released = new Promise<T>((r) => (release = r));
  const entered = new Promise<void>((r) => (markEntered = r));
  return {
    release,
    entered,
    wait: () => {
      markEntered();
      return released;
    },
  };
}

/**
 * A child that ignores SIGTERM — the real one's handler closes every session
 * before its server, so a wedged session keeps the socket for the whole grace
 * period — and dies `exitAfterKillMs` after SIGKILL, reporting it the way
 * Node does for a signal death (`exitCode: null`, `signalCode` set).
 */
function stuckChild(exitAfterKillMs: number) {
  const c = fakeChild();
  c.kill = vi.fn((sig?: string) => {
    if (sig === "SIGKILL") {
      setTimeout(() => {
        c.signalCode = "SIGKILL";
        c.emit("exit", null, "SIGKILL");
      }, exitAfterKillMs);
    }
    return true;
  });
  return c;
}

/** `p`, or "still waiting" if it has not settled within `ms`; the guard timer is cleared either way. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "still waiting"> {
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<"still waiting">((r) => {
        guard = setTimeout(() => r("still waiting"), ms);
      }),
    ]);
  } finally {
    clearTimeout(guard);
  }
}

describe("startMcpHttpChild", () => {
  it("spawns the entry with LIBI_MCP_PORT, waits for /healthz, writes the port file", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const fetch = vi.fn(async () => new Response(HEALTHY_BODY, { status: 200 }));
    const portFile = tmpPortFile();
    const handle = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: fetch as never,
      portFile,
      entry: () => ({ command: "node", args: ["x.js"], env: {} }),
      pickPort: async () => 3999,
    });
    expect(spawn).toHaveBeenCalledWith(
      "node",
      ["x.js"],
      expect.objectContaining({ env: expect.objectContaining({ LIBI_MCP_PORT: "3999" }) }),
    );
    // A non-secret marker the child keeps for its whole life, unlike the health token its entry deletes.
    expect(spawn).toHaveBeenCalledWith("node", ["x.js"], expect.objectContaining({ env: expect.objectContaining({ LIBI_MCP_SUPERVISED: "1" }) }));
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3999/healthz",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fs.readFileSync(portFile, "utf-8")).toBe("3999");
    expect(handle.port).toBe(3999);
    expect(handle.status()).toBe("running");
    await handle.stop();
    expect(child.kill).toHaveBeenCalled();
    expect(fs.existsSync(portFile)).toBe(false);
    expect(handle.status()).toBe("stopped");
  });

  it("restarts once after an unexpected exit, then gives up after 3 tries", async () => {
    const children = [fakeChild(), fakeChild(), fakeChild(), fakeChild()];
    let i = 0;
    const spawn = vi.fn(() => children[i++]);
    const fetch = vi.fn(async () => new Response(HEALTHY_BODY, { status: 200 }));
    const portFile = tmpPortFile();
    const onGaveUp = vi.fn();
    const handle = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: fetch as never,
      portFile,
      entry: () => ({ command: "n", args: [], env: {} }),
      pickPort: async () => 3999,
      restartDelayMs: 1,
      onGaveUp,
    });
    for (const c of children.slice(0, 3)) {
      c.exitCode = 1;
      c.emit("exit", 1, null);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(spawn).toHaveBeenCalledTimes(4);
    children[3].exitCode = 1;
    children[3].emit("exit", 1, null);
    await new Promise((r) => setTimeout(r, 10));
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(onGaveUp).toHaveBeenCalledTimes(1);
    expect(handle.status()).toBe("gave-up");
    // Nothing is listening on the port any more; leaving `mcp-port` behind
    // points every MCP client at a dead socket.
    expect(fs.existsSync(portFile)).toBe(false);
  });

  it("kills a restarted child that never becomes healthy and counts it as an attempt", async () => {
    const children = [fakeChild(), fakeChild(), fakeChild(), fakeChild(), fakeChild()];
    let i = 0;
    const spawn = vi.fn(() => children[i++]);
    // Healthy for the first launch only: every restart from here on comes up
    // wedged, which must be treated as a failure rather than a recovery.
    let healthy = true;
    const fetch = vi.fn(async () => {
      if (!healthy) throw new Error("ECONNREFUSED");
      return new Response(HEALTHY_BODY, { status: 200 });
    });
    const onGaveUp = vi.fn();
    const handle = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: fetch as never,
      portFile: tmpPortFile(),
      entry: () => ({ command: "n", args: [], env: {} }),
      pickPort: async () => 3999,
      restartDelayMs: 1,
      healthTimeoutMs: 50,
      onGaveUp,
    });
    healthy = false;
    children[0].exitCode = 1;
    children[0].emit("exit", 1, null);

    await waitFor(() => children[1].kill.mock.calls.length > 0, "the restart to be killed");
    expect(children[1].kill).toHaveBeenCalledWith("SIGKILL");
    // Killed, and counted: the supervisor keeps spending the restart budget
    // instead of sitting on a child it never proved was up.
    await waitFor(() => onGaveUp.mock.calls.length > 0, "the supervisor to give up");
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(handle.status()).toBe("gave-up");
  });

  it("forgives the restart budget once a restart has stayed healthy", async () => {
    const children = Array.from({ length: 6 }, () => fakeChild());
    let i = 0;
    const spawn = vi.fn(() => children[i++]);
    let healthy = true;
    const fetch = vi.fn(async () => {
      if (!healthy) throw new Error("ECONNREFUSED");
      return new Response(HEALTHY_BODY, { status: 200 });
    });
    const onGaveUp = vi.fn();
    await startMcpHttpChild({
      spawn: spawn as never,
      fetch: fetch as never,
      portFile: tmpPortFile(),
      entry: () => ({ command: "n", args: [], env: {} }),
      pickPort: async () => 3999,
      restartDelayMs: 1,
      healthTimeoutMs: 50,
      healthyResetMs: 5,
      onGaveUp,
    });
    // One crash, recovered: children[1] comes up and answers /healthz.
    children[0].exitCode = 1;
    children[0].emit("exit", 1, null);
    await waitFor(() => spawn.mock.calls.length === 2, "the first restart");
    await new Promise((r) => setTimeout(r, 20)); // healthyResetMs elapses

    // The crash above has been forgiven, so the FULL budget is available
    // again: three more failed attempts must not be enough to give up.
    healthy = false;
    children[1].exitCode = 1;
    children[1].emit("exit", 1, null);
    await waitFor(() => spawn.mock.calls.length === 5, "three further restart attempts");
    expect(onGaveUp).not.toHaveBeenCalled();
    // …and the fourth is.
    await waitFor(() => onGaveUp.mock.calls.length > 0, "the supervisor to give up");
    expect(spawn).toHaveBeenCalledTimes(5);
  });

  it("never restarts after stop() — a shutdown must not resurrect the child", async () => {
    const children = [fakeChild(), fakeChild()];
    let i = 0;
    const spawn = vi.fn(() => children[i++]);
    const fetch = vi.fn(async () => new Response(HEALTHY_BODY, { status: 200 }));
    const handle = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: fetch as never,
      portFile: tmpPortFile(),
      entry: () => ({ command: "n", args: [], env: {} }),
      pickPort: async () => 3999,
      restartDelayMs: 1,
    });
    await handle.stop();
    await new Promise((r) => setTimeout(r, 20));
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("a first launch whose healthz never answers is killed and ends gave-up with no port file, rather than rejecting", async () => {
    // Resolving, not rejecting, is deliberate: the handle is what the Restart
    // button recovers (see "a first launch that is slow, or never answers").
    const child = fakeChild();
    const fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const portFile = tmpPortFile();
    const handle = await startMcpHttpChild({
      spawn: (() => child) as never,
      fetch: fetch as never,
      portFile,
      entry: () => ({ command: "n", args: [], env: {} }),
      pickPort: async () => 3999,
      healthTimeoutMs: 50,
    });
    expect(handle.status()).toBe("gave-up");
    expect(child.kill).toHaveBeenCalled();
    expect(fs.existsSync(portFile)).toBe(false);
  });

  it("a first launch against a listener that accepts and never answers still gives up at its health window", async () => {
    // Whatever holds the port accepts the connection and never writes back, so
    // a /healthz request stays pending. Each attempt has to end on its own, or
    // the window is never checked again and the boot, with every studio
    // request queued behind it, waits on the HTTP client's own timeout instead.
    const child = fakeChild();
    const fetch = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    const portFile = tmpPortFile();
    const started = Date.now();
    const outcome = await within(
      startMcpHttpChild({
        spawn: (() => child) as never,
        fetch: fetch as never,
        portFile,
        entry: () => ({ command: "n", args: [], env: {} }),
        pickPort: async () => 3999,
        healthTimeoutMs: 200,
      }),
      3_000,
    );
    expect(outcome).not.toBe("still waiting");
    expect((outcome as McpHttpChildHandle).status()).toBe("gave-up");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(child.kill).toHaveBeenCalled();
    expect(fs.existsSync(portFile)).toBe(false);
  });

  it("a first launch whose child exits before the window closes gives up naming the exit, not the health window (a pinned port cannot be repicked off)", async () => {
    // A pinned LIBI_MCP_PORT-style port picker always returns the same value,
    // so the repick a bind failure normally triggers lands right back on the
    // port the child just failed on: nothing moves, and the launch ends
    // gave-up on the child that already exited rather than a repicked one.
    vi.useFakeTimers();
    const child = fakeChild();
    const spawn = vi.fn(() => {
      setTimeout(() => {
        child.exitCode = 1;
        child.emit("exit", 1, null);
      }, 0);
      return child;
    });
    const fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const portFile = tmpPortFile();
    const onGaveUp = vi.fn();
    let outcome: McpHttpChildHandle | undefined;
    void startMcpHttpChild({
      spawn: spawn as never,
      fetch: fetch as never,
      portFile,
      entry: () => ({ command: "n", args: [], env: {} }),
      pickPort: async () => 3999,
      isFree: async () => false,
      healthTimeoutMs: 50,
      onGaveUp,
    }).then((handle) => (outcome = handle));

    await vi.advanceTimersByTimeAsync(200);
    expect(outcome).toBeDefined();
    expect(outcome!.status()).toBe("gave-up");
    // Already gone — nothing left to kill.
    expect(child.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(portFile)).toBe(false);
    expect(onGaveUp).toHaveBeenCalledTimes(1);
    const err = onGaveUp.mock.calls[0][0] as Error;
    expect(err.message).toMatch(/exited before becoming healthy \(code 1\)/);
    expect(err.message).not.toMatch(/did not become healthy within/);
    // This block's other tests rely on real timers; leave fake ones behind.
    vi.useRealTimers();
  });

  it("re-picks the port when the first child cannot bind, and republishes it", async () => {
    // Two libi instances starting within a second both pick 3457; the loser's
    // child dies on EADDRINUSE, and relaunching it on the same port just loses
    // again — the supervisor has to move.
    const children = [fakeChild(), fakeChild()];
    let i = 0;
    const spawnedEnvs: Array<Record<string, string>> = [];
    const spawn = vi.fn((_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
      spawnedEnvs.push(opts.env);
      const c = children[i++];
      if (i === 1) {
        // Gone before the first health poll — the bind failed.
        c.exitCode = 1;
        setTimeout(() => c.emit("exit", 1, null), 0);
      }
      return c;
    });
    const fetch = vi.fn(async () => {
      if (i < 2) throw new Error("ECONNREFUSED");
      return new Response(HEALTHY_BODY, { status: 200 });
    });
    // 3457 is taken by the other instance by the time we re-probe it.
    const isFree = vi.fn(async () => false);
    let picks = 0;
    const pickPort = vi.fn(async () => (picks++ === 0 ? DEFAULT_MCP_PORT : 3501));
    const onPortChanged = vi.fn();
    const portFile = tmpPortFile();

    const handle = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: fetch as never,
      portFile,
      entry: () => ({ command: "n", args: [], env: {} }),
      pickPort,
      isFree,
      onPortChanged,
      healthTimeoutMs: 500,
      restartDelayMs: 5,
    });

    expect(spawnedEnvs[0].LIBI_MCP_PORT).toBe(String(DEFAULT_MCP_PORT));
    expect(spawnedEnvs[1].LIBI_MCP_PORT).toBe("3501");
    expect(pickPort).toHaveBeenCalledTimes(2);
    // `published` is still false at this point in the first-launch flow — no
    // port file and no ACP session has this port yet, so there is nothing to
    // notify. The normal post-health publish below covers it instead.
    expect(onPortChanged).not.toHaveBeenCalled();
    expect(handle.port).toBe(3501);
    expect(fs.readFileSync(portFile, "utf-8")).toBe("3501");
    await handle.stop();
  });

  it("hands every launch its parent server's port in LIBI_SERVER_PORT: first launch, a crash relaunch on a re-picked port, and a user restart", async () => {
    // The child resolves the studio through `getCurrentPort()`. The shared
    // `<LIBI_HOME>/port` file names whichever instance booted last, so a child
    // that reads only the file follows a second launch's port, and keeps
    // following it after that launch has exited.
    const saved = { PORT: process.env.PORT, LIBI_PORT: process.env.LIBI_PORT };
    process.env.PORT = "55268";
    process.env.LIBI_PORT = "55268";
    try {
      const children = [fakeChild(), fakeChild(), fakeChild()];
      let i = 0;
      const spawnedEnvs: Array<Record<string, string>> = [];
      const spawn = vi.fn((_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
        spawnedEnvs.push(opts.env);
        return children[i++];
      });
      const fetch = vi.fn(async () => new Response(HEALTHY_BODY, { status: 200 }));
      let taken = true;
      const isFree = vi.fn(async () => !taken);
      let picks = 0;
      const pickPort = vi.fn(async () => (picks++ === 0 ? 3999 : 4123));
      const handle = await startMcpHttpChild({
        spawn: spawn as never,
        fetch: fetch as never,
        portFile: tmpPortFile(),
        // An inherited value must not win over the parent's own port.
        entry: () => ({ command: "n", args: [], env: { LIBI_SERVER_PORT: "55303" } }),
        pickPort,
        isFree,
        restartDelayMs: 1,
      });
      children[0].exitCode = 1;
      queueMicrotask(() => children[0].emit("exit", 1, null));
      await waitFor(() => handle.publishedPort === 4123, "the crash relaunch to publish its re-picked port");
      taken = false;
      await handle.restart();

      expect(spawnedEnvs.map((e) => e.LIBI_MCP_PORT)).toEqual(["3999", "4123", "4123"]);
      expect(spawnedEnvs.map((e) => e.LIBI_SERVER_PORT)).toEqual(["55268", "55268", "55268"]);
      await handle.stop();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("stop() leaves an mcp-port file another instance has published since, and removes its own", async () => {
    const spawn = vi.fn(() => fakeChild());
    const fetch = vi.fn(async () => new Response(HEALTHY_BODY, { status: 200 }));
    const theirs = tmpPortFile();
    const other = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: fetch as never,
      portFile: theirs,
      entry: () => ({ command: "n", args: [], env: {} }),
      pickPort: async () => 3999,
    });
    expect(fs.readFileSync(theirs, "utf-8")).toBe("3999");
    // A second instance, sharing the home, published its own aggregator.
    fs.writeFileSync(theirs, "55304");
    await other.stop();
    expect(fs.readFileSync(theirs, "utf-8")).toBe("55304");

    const mine = tmpPortFile();
    const own = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: fetch as never,
      portFile: mine,
      entry: () => ({ command: "n", args: [], env: {} }),
      pickPort: async () => 4000,
    });
    await own.stop();
    expect(fs.existsSync(mine)).toBe(false);
  });

  describe("mcp-port belongs to the supervisor that published it", () => {
    // Two libi instances on one home share `<LIBI_HOME>/mcp-port`, and whichever
    // published last owns it. Every path that removes the file has to leave the
    // other instance's alone, or its clients find no endpoint.
    const OTHER_INSTANCE_PORT = "55304";
    const healthy = async () => new Response(HEALTHY_BODY, { status: 200 });
    const plain = () => ({ command: "n", args: [], env: {} });

    it("a crash give-up leaves an mcp-port file another instance has published since", async () => {
      const child = fakeChild();
      const portFile = tmpPortFile();
      const onGaveUp = vi.fn();
      const handle = await startMcpHttpChild({
        spawn: (() => child) as never,
        fetch: healthy as never,
        portFile,
        entry: plain,
        pickPort: async () => 3999,
        maxRestarts: 0,
        restartDelayMs: 1,
        onGaveUp,
      });
      fs.writeFileSync(portFile, OTHER_INSTANCE_PORT);
      child.exitCode = 1;
      child.emit("exit", 1, null);
      expect(handle.status()).toBe("gave-up");
      expect(onGaveUp).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(portFile, "utf-8")).toBe(OTHER_INSTANCE_PORT);
      await handle.stop();
      expect(fs.readFileSync(portFile, "utf-8")).toBe(OTHER_INSTANCE_PORT);
    });

    it("a crash-path relaunch that fails before a child exists leaves an mcp-port file another instance has published since", async () => {
      let failing = false;
      const child = fakeChild();
      const portFile = tmpPortFile();
      const onGaveUp = vi.fn();
      const handle = await startMcpHttpChild({
        spawn: (() => child) as never,
        fetch: healthy as never,
        portFile,
        entry: plain,
        pickPort: async () => {
          if (failing) throw new Error("no free port");
          return 3999;
        },
        // The picker is consulted only when the current port is taken.
        isFree: async () => !failing,
        restartDelayMs: 1,
        onGaveUp,
      });
      failing = true;
      fs.writeFileSync(portFile, OTHER_INSTANCE_PORT);
      child.exitCode = 1;
      child.emit("exit", 1, null);
      await waitFor(() => handle.status() === "gave-up", "the failed crash relaunch to give up");
      expect(onGaveUp).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(portFile, "utf-8")).toBe(OTHER_INSTANCE_PORT);
    });

    it("a user restart that fails before a child exists leaves an mcp-port file another instance has published since", async () => {
      let failPick = false;
      const child = fakeChild();
      const portFile = tmpPortFile();
      const handle = await startMcpHttpChild({
        spawn: (() => child) as never,
        fetch: healthy as never,
        portFile,
        entry: plain,
        pickPort: async () => {
          if (failPick) throw new Error("no free port");
          return 3999;
        },
        // The old port reads as taken, so the restart has to go through the picker.
        isFree: async () => false,
        restartDelayMs: 1,
      });
      failPick = true;
      fs.writeFileSync(portFile, OTHER_INSTANCE_PORT);
      await expect(handle.restart()).rejects.toThrow(/no free port/);
      expect(handle.status()).toBe("gave-up");
      expect(fs.readFileSync(portFile, "utf-8")).toBe(OTHER_INSTANCE_PORT);
    });

    it("stop() after a give-up leaves an mcp-port another instance has since published on the same port number", async () => {
      // Port numbers are not identity: once this supervisor dropped its file,
      // another instance may find the same port free and publish it.
      const child = fakeChild();
      const portFile = tmpPortFile();
      const handle = await startMcpHttpChild({
        spawn: (() => child) as never,
        fetch: healthy as never,
        portFile,
        entry: plain,
        pickPort: async () => 3999,
        maxRestarts: 0,
        restartDelayMs: 1,
      });
      child.exitCode = 1;
      child.emit("exit", 1, null);
      expect(handle.status()).toBe("gave-up");
      expect(fs.existsSync(portFile)).toBe(false);
      fs.writeFileSync(portFile, "3999");
      await handle.stop();
      expect(fs.readFileSync(portFile, "utf-8")).toBe("3999");
    });

    it("a first launch that gives up leaves an mcp-port file naming a port something still listens on", async () => {
      // Another instance's aggregator answers on the default port, and the file
      // is its live one; this launch's own child never comes up.
      const child = fakeChild();
      const portFile = tmpPortFile();
      fs.writeFileSync(portFile, String(DEFAULT_MCP_PORT));
      const picks = [DEFAULT_MCP_PORT, 4100];
      const onGaveUp = vi.fn();
      const handle = await startMcpHttpChild({
        spawn: (() => child) as never,
        fetch: (async () => new Response(JSON.stringify({ ok: true, version: "other" }), { status: 200 })) as never,
        portFile,
        entry: plain,
        pickPort: async () => picks.shift()!,
        isFree: async (p) => p !== DEFAULT_MCP_PORT,
        healthTimeoutMs: 50,
        onGaveUp,
      });
      expect(handle.status()).toBe("gave-up");
      expect(onGaveUp).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(portFile, "utf-8")).toBe(String(DEFAULT_MCP_PORT));
    });

    it("a first launch that gives up removes a left-over mcp-port file that does not name a port", async () => {
      const child = fakeChild();
      const portFile = tmpPortFile();
      fs.writeFileSync(portFile, "not-a-port");
      const handle = await startMcpHttpChild({
        spawn: (() => child) as never,
        fetch: (async () => {
          throw new Error("ECONNREFUSED");
        }) as never,
        portFile,
        entry: plain,
        pickPort: async () => 3999,
        isFree: async () => false,
        healthTimeoutMs: 50,
      });
      expect(handle.status()).toBe("gave-up");
      expect(fs.existsSync(portFile)).toBe(false);
    });

    it("a first launch that gives up removes a left-over mcp-port naming its own killed child's port, though that child has not let go of it yet", async () => {
      // An earlier run crashed and left `3999`; this launch took the free 3999,
      // its child never answered, and the give-up killed it. The kill is
      // delivered asynchronously (taskkill on Windows), so right after it the
      // port still reads as held, by the child on its way out.
      const child = stuckChild(20);
      const portFile = tmpPortFile();
      fs.writeFileSync(portFile, "3999");
      const handle = await startMcpHttpChild({
        spawn: (() => child) as never,
        fetch: (async () => {
          throw new Error("ECONNREFUSED");
        }) as never,
        portFile,
        entry: plain,
        pickPort: async () => 3999,
        isFree: async () => child.signalCode === "SIGKILL",
        healthTimeoutMs: 50,
      });
      expect(handle.status()).toBe("gave-up");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(fs.existsSync(portFile)).toBe(false);
      await waitFor(() => child.signalCode === "SIGKILL", "the killed child to exit");
    });

    it("a first launch whose child exited before giving up leaves an mcp-port naming that port while something still listens on it", async () => {
      // A child that dies before answering most likely could not bind: whatever
      // holds the port may be the instance that published this file.
      const child = fakeChild();
      const portFile = tmpPortFile();
      fs.writeFileSync(portFile, "3999");
      const handle = await startMcpHttpChild({
        spawn: (() => {
          setTimeout(() => {
            child.exitCode = 1;
            child.emit("exit", 1, null);
          }, 5);
          return child;
        }) as never,
        fetch: (async () => {
          throw new Error("ECONNREFUSED");
        }) as never,
        portFile,
        entry: plain,
        pickPort: async () => 3999,
        isFree: async () => false,
        healthTimeoutMs: 1_000,
      });
      expect(handle.status()).toBe("gave-up");
      expect(fs.readFileSync(portFile, "utf-8")).toBe("3999");
    });

    it("a stop() that lands while a first launch's give-up checks a left-over mcp-port ends it stopped, reporting no give-up", async () => {
      const error = vi.spyOn(serverLogger, "error");
      try {
        const child = fakeChild();
        const portFile = tmpPortFile();
        fs.writeFileSync(portFile, OTHER_INSTANCE_PORT);
        const probe = gate<boolean>();
        const onGaveUp = vi.fn();
        let early: McpHttpChildHandle | undefined;
        const start = startMcpHttpChild({
          spawn: (() => child) as never,
          fetch: (async () => {
            throw new Error("ECONNREFUSED");
          }) as never,
          portFile,
          entry: plain,
          pickPort: async () => 3999,
          isFree: () => probe.wait(),
          healthTimeoutMs: 50,
          onGaveUp,
          onHandle: (h) => (early = h),
        });
        await probe.entered;
        // libi quits while the give-up is still probing the file's port.
        await early!.stop();
        probe.release(true);
        const handle = await start;
        expect(handle.status()).toBe("stopped");
        expect(onGaveUp).not.toHaveBeenCalled();
        expect(error.mock.calls.map(([o]) => (o as { op?: string }).op)).not.toContain("child_start_gave_up");
      } finally {
        error.mockRestore();
      }
    });
  });

  it("does not re-pick when the port is still free at restart time", async () => {
    const children = [fakeChild(), fakeChild()];
    let i = 0;
    const spawn = vi.fn(() => children[i++]);
    const fetch = vi.fn(async () => new Response(HEALTHY_BODY, { status: 200 }));
    const isFree = vi.fn(async () => true);
    const pickPort = vi.fn(async () => 3999);
    const onPortChanged = vi.fn();
    const handle = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: fetch as never,
      portFile: tmpPortFile(),
      entry: () => ({ command: "n", args: [], env: {} }),
      pickPort,
      isFree,
      onPortChanged,
      restartDelayMs: 1,
    });
    children[0].exitCode = 1;
    children[0].emit("exit", 1, null);
    await waitFor(() => spawn.mock.calls.length === 2, "the restart to spawn");
    expect(isFree).toHaveBeenCalledWith(3999);
    expect(pickPort).toHaveBeenCalledTimes(1);
    expect(onPortChanged).not.toHaveBeenCalled();
    expect(handle.port).toBe(3999);
    await handle.stop();
  });

  it("a restart-time re-pick rewrites the port file and THEN notifies onPortChanged with the new port", async () => {
    const children = [fakeChild(), fakeChild()];
    let i = 0;
    const spawnedEnvs: Array<Record<string, string>> = [];
    const spawn = vi.fn((_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
      spawnedEnvs.push(opts.env);
      return children[i++];
    });
    const fetch = vi.fn(async () => new Response(HEALTHY_BODY, { status: 200 }));
    const portFile = tmpPortFile();
    const PORT_A = 3999;
    const PORT_B = 4123;
    // The port reads busy at restart time — someone else took it while we
    // were up — so the supervisor has to move rather than relaunch into the
    // same collision.
    const isFree = vi.fn(async () => false);
    let picks = 0;
    const pickPort = vi.fn(async () => (picks++ === 0 ? PORT_A : PORT_B));
    const portFileContentsAtNotify: string[] = [];
    const onPortChanged = vi.fn(() => {
      // Captured INSIDE the mock, not after — this is the only way to prove
      // the file write happened before the notify rather than merely before
      // the next assertion.
      portFileContentsAtNotify.push(fs.readFileSync(portFile, "utf-8"));
    });

    const handle = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: fetch as never,
      portFile,
      entry: () => ({ command: "n", args: [], env: {} }),
      pickPort,
      isFree,
      onPortChanged,
      restartDelayMs: 1,
    });

    expect(handle.port).toBe(PORT_A);
    expect(fs.readFileSync(portFile, "utf-8")).toBe(String(PORT_A));

    // The CURRENT child exits unexpectedly — a legitimate crash, not a bind
    // failure — while the old port is taken and the picker is ready to hand
    // back a different one.
    children[0].exitCode = 1;
    queueMicrotask(() => children[0].emit("exit", 1, null));

    await waitFor(() => spawn.mock.calls.length === 2, "the restart to spawn");
    await waitFor(() => onPortChanged.mock.calls.length > 0, "onPortChanged to fire");

    expect(spawnedEnvs[1].LIBI_MCP_PORT).toBe(String(PORT_B));
    expect(fs.readFileSync(portFile, "utf-8")).toBe(String(PORT_B));
    expect(onPortChanged).toHaveBeenCalledTimes(1);
    expect(onPortChanged).toHaveBeenCalledWith(PORT_B);
    // ORDER: the port file already carried the new port at the moment
    // onPortChanged fired — publish, then notify, never the other way round.
    expect(portFileContentsAtNotify).toEqual([String(PORT_B)]);

    await handle.stop();
  });

  it("resets the restart budget once the first-launch re-pick succeeds", async () => {
    // The first child dies on a bind failure (EADDRINUSE), which runs the
    // STANDARD `exit` handler and bumps `restarts` even though this isn't a
    // real crash recovery — it's the normal "the default port is taken"
    // dance. That budget must be returned once the re-picked child passes
    // its health check, so three LEGITIMATE crashes afterwards still get
    // restarted instead of giving up early.
    const children = Array.from({ length: 5 }, () => fakeChild());
    let i = 0;
    const spawn = vi.fn(() => {
      const c = children[i++];
      if (i === 1) {
        // Gone before the first health poll — the bind failed. Real Node
        // sets `exitCode` and fires `exit` together (same libuv callback);
        // a microtask is the closest a fake can get without racing the
        // `.on("exit", …)` registration that `launch()` does right after
        // `spawn()` returns.
        c.exitCode = 1;
        queueMicrotask(() => c.emit("exit", 1, null));
      }
      return c;
    });
    const fetch = vi.fn(async () => {
      if (i < 2) throw new Error("ECONNREFUSED");
      return new Response(HEALTHY_BODY, { status: 200 });
    });
    const isFree = vi.fn(async () => false); // 3457 is taken by another instance
    let picks = 0;
    const pickPort = vi.fn(async () => (picks++ === 0 ? DEFAULT_MCP_PORT : 3501));
    const onGaveUp = vi.fn();
    const portFile = tmpPortFile();

    const handle = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: fetch as never,
      portFile,
      entry: () => ({ command: "n", args: [], env: {} }),
      pickPort,
      isFree,
      restartDelayMs: 1,
      healthTimeoutMs: 500,
      onGaveUp,
    });
    expect(handle.port).toBe(3501);
    expect(spawn).toHaveBeenCalledTimes(2);

    // Three legitimate crashes: each must be restarted. A buggy version
    // leaves `restarts` at 1 after the re-pick, which would give up after
    // only two of these.
    for (const idx of [1, 2, 3]) {
      children[idx].exitCode = 1;
      children[idx].emit("exit", 1, null);
      await waitFor(() => spawn.mock.calls.length === idx + 2, `restart #${idx} to spawn`);
    }
    expect(onGaveUp).not.toHaveBeenCalled();

    // …and the fourth exhausts the (full) budget.
    children[4].exitCode = 1;
    children[4].emit("exit", 1, null);
    await waitFor(() => onGaveUp.mock.calls.length > 0, "the supervisor to give up");
    expect(spawn).toHaveBeenCalledTimes(5);
  });

  it("lets repickIfTaken observe stop() while suspended on the port picker", async () => {
    const children = [fakeChild(), fakeChild()];
    let i = 0;
    const spawn = vi.fn(() => children[i++]);
    const fetch = vi.fn(async () => new Response(HEALTHY_BODY, { status: 200 }));
    const isFree = vi.fn(async () => false); // port reads busy at restart time
    let resolvePick!: (p: number) => void;
    const pickDeferred = new Promise<number>((resolve) => {
      resolvePick = resolve;
    });
    let pickCalls = 0;
    const pickPort = vi.fn(async () => {
      pickCalls++;
      // The initial pick (before the first spawn) resolves normally; only
      // the restart-time re-pick hangs, so it can be suspended under stop().
      return pickCalls === 1 ? 3999 : pickDeferred;
    });
    const onPortChanged = vi.fn();
    const portFile = tmpPortFile();

    const handle = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: fetch as never,
      portFile,
      entry: () => ({ command: "n", args: [], env: {} }),
      pickPort,
      isFree,
      onPortChanged,
      restartDelayMs: 1,
    });
    expect(fs.readFileSync(portFile, "utf-8")).toBe("3999");

    // A legitimate crash schedules a restart, which enters `repickIfTaken`
    // and suspends on the (still-unresolved) port picker.
    children[0].exitCode = 1;
    children[0].emit("exit", 1, null);
    await waitFor(() => pickCalls === 2, "the restart-time re-pick to start");

    await handle.stop();
    expect(fs.existsSync(portFile)).toBe(false);

    // Only now does the picker resolve — `repickIfTaken` must notice the
    // shutdown and do nothing with the answer: no port file, no notify, no
    // relaunch.
    resolvePick(4000);
    await new Promise((r) => setTimeout(r, 20));

    expect(onPortChanged).not.toHaveBeenCalled();
    expect(fs.existsSync(portFile)).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

/**
 * The port must be STABLE across launches, which is the whole reason the
 * fixed default is preferred over anything derived from the studio port:
 * `libi connect` writes the URL statically into `~/.claude.json`, and the
 * packaged desktop studio binds `listen(0)`, so a derived port moved on every
 * app start and the saved registration went dead after one restart.
 *
 * `isFree`/`freePort` really bind sockets, so both are injected here.
 */
describe("pickMcpHttpPort", () => {
  const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

  it("prefers the fixed default when it is free, whatever the studio port is", async () => {
    const isFree = vi.fn(async () => true);
    const freePort = vi.fn(async () => 55555);
    expect(await pickMcpHttpPort(env({ PORT: "3500" }), { isFree, freePort })).toBe(
      DEFAULT_MCP_PORT,
    );
    expect(isFree).toHaveBeenCalledWith(DEFAULT_MCP_PORT);
    expect(freePort).not.toHaveBeenCalled();
  });

  it("falls back to the studio port + 1 when the default is taken", async () => {
    const isFree = vi.fn(async (p: number) => p !== DEFAULT_MCP_PORT);
    const freePort = vi.fn(async () => 55555);
    expect(await pickMcpHttpPort(env({ PORT: "3500" }), { isFree, freePort })).toBe(3501);
    expect(freePort).not.toHaveBeenCalled();
  });

  it("falls back to an ephemeral free port when both are taken", async () => {
    const isFree = vi.fn(async () => false);
    const freePort = vi.fn(async () => 55555);
    expect(await pickMcpHttpPort(env({ PORT: "3500" }), { isFree, freePort })).toBe(55555);
    expect(isFree).toHaveBeenCalledWith(DEFAULT_MCP_PORT);
    expect(isFree).toHaveBeenCalledWith(3501);
  });

  it("obeys LIBI_MCP_PORT without probing anything", async () => {
    const isFree = vi.fn(async () => false);
    const freePort = vi.fn(async () => 55555);
    expect(await pickMcpHttpPort(env({ LIBI_MCP_PORT: "4100", PORT: "3500" }), { isFree, freePort })).toBe(4100);
    expect(isFree).not.toHaveBeenCalled();
    expect(freePort).not.toHaveBeenCalled();
  });

  it("ignores an INVALID LIBI_MCP_PORT and continues down the normal chain", async () => {
    // Branching on the raw env value's truthiness made `abc` short-circuit to
    // the default without probing it — a pin that cannot be parsed is not a pin.
    const isFree = vi.fn(async (p: number) => p !== DEFAULT_MCP_PORT);
    const freePort = vi.fn(async () => 55555);
    expect(
      await pickMcpHttpPort(env({ LIBI_MCP_PORT: "abc", PORT: "3500" }), { isFree, freePort }),
    ).toBe(3501);
    expect(isFree).toHaveBeenCalledWith(DEFAULT_MCP_PORT);
    expect(freePort).not.toHaveBeenCalled();
  });

  it("does not probe the studio-derived port twice when it IS the default", async () => {
    // Studio 3456 derives 3457 — already known busy, so probing it again
    // would just be a wasted bind on the way to the ephemeral fallback.
    const isFree = vi.fn(async () => false);
    const freePort = vi.fn(async () => 55555);
    expect(await pickMcpHttpPort(env({ PORT: "3456" }), { isFree, freePort })).toBe(55555);
    expect(isFree).toHaveBeenCalledTimes(1);
  });
});

describe("restart() — user-driven", () => {
  async function running(
    opts: {
      isFree?: (p: number) => Promise<boolean>;
      pickPort?: () => Promise<number>;
      onPortChanged?: (p: number) => void;
    } = {},
  ) {
    const children = [fakeChild(), fakeChild(), fakeChild()];
    let i = 0;
    const spawn = vi.fn(() => children[i++]);
    const fetch = vi.fn(async () => new Response(HEALTHY_BODY, { status: 200 }));
    const portFile = tmpPortFile();
    const handle = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: fetch as never,
      portFile,
      entry: () => ({ command: "node", args: ["x.js"], env: {} }),
      pickPort: opts.pickPort ?? (async () => 3999),
      isFree: opts.isFree ?? (async () => true),
      onPortChanged: opts.onPortChanged,
      maxRestarts: 1,
      restartDelayMs: 1,
    });
    return { handle, children, spawn, portFile };
  }

  it("stops the child, relaunches on the SAME port, health-checks, and rewrites the port file", async () => {
    const { handle, children, spawn, portFile } = await running();
    const p = handle.restart();
    expect(handle.status()).toBe("restarting");
    await p;
    expect(children[0].kill).toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(handle.port).toBe(3999);
    expect(fs.readFileSync(portFile, "utf-8")).toBe("3999");
    expect(handle.status()).toBe("running");
    await handle.stop();
  });

  it("falls through pickPort and fires onPortChanged when the old port is taken", async () => {
    const onPortChanged = vi.fn();
    let freeCalls = 0;
    const { handle, portFile } = await running({
      // Every probe says taken. None happen before restart(): a HEALTHY first launch never
      // probes isFree (`repickIfTaken` runs only after a first launch that failed to bind).
      isFree: async () => {
        freeCalls++;
        return false;
      },
      pickPort: async () => (freeCalls === 0 ? 3999 : 4001),
      onPortChanged,
    });
    await handle.restart();
    expect(handle.port).toBe(4001);
    expect(onPortChanged).toHaveBeenCalledWith(4001);
    expect(fs.readFileSync(portFile, "utf-8")).toBe("4001");
    await handle.stop();
  });

  it("recovers a gave-up supervisor: the budget is reset and the child runs again", async () => {
    const { handle, children, spawn } = await running();
    // Two unexpected exits with maxRestarts:1 → gave-up. Wait for the crash-path relaunch to
    // actually spawn children[1] (a 1 ms timer) before making IT exit — emitting on a child
    // nobody is listening to yet does nothing.
    children[0].exitCode = 1;
    children[0].emit("exit", 1, null);
    await waitFor(() => spawn.mock.calls.length === 2, "the crash-path relaunch");
    children[1].exitCode = 1;
    children[1].emit("exit", 1, null);
    await waitFor(() => handle.status() === "gave-up", "gave-up");
    await handle.restart();
    expect(handle.status()).toBe("running");
    await handle.stop();
  });

  it("rejects after stop(), and leaves status stopped", async () => {
    const { handle } = await running();
    await handle.stop();
    await expect(handle.restart()).rejects.toThrow(/stopped/);
    expect(handle.status()).toBe("stopped");
  });

  it("an unhealthy relaunch rejects and is counted like any other failed launch", async () => {
    const children = [fakeChild(), fakeChild()];
    let i = 0;
    const spawn = vi.fn(() => children[i++]);
    let healthy = true;
    const fetch = vi.fn(async () => new Response(HEALTHY_BODY, { status: healthy ? 200 : 503 }));
    const handle = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: fetch as never,
      portFile: tmpPortFile(),
      entry: () => ({ command: "node", args: ["x.js"], env: {} }),
      pickPort: async () => 3999,
      isFree: async () => true,
      healthTimeoutMs: 50,
      maxRestarts: 0,
      restartDelayMs: 1,
    });
    healthy = false;
    await expect(handle.restart()).rejects.toThrow(/healthy/);
    expect(children[1].kill).toHaveBeenCalled();
    await waitFor(() => handle.status() === "gave-up", "gave-up after the failed relaunch");
  });

  it("a stop() that lands during restart() wins: no relaunch, status stays stopped (a shutdown must not resurrect the child)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = false;
    const { handle, spawn } = await running({
      isFree: async () => {
        if (gated) await gate;
        return true;
      },
    });
    gated = true;
    const p = handle.restart();
    await handle.stop();
    release();
    await expect(p).rejects.toThrow(/stopped during restart/);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(handle.status()).toBe("stopped");
  });

  it("a second restart() while the first is still health-checking rejects as already restarting and leaves the relaunch alone", async () => {
    const children = [fakeChild(), fakeChild(), fakeChild()];
    let i = 0;
    const spawn = vi.fn(() => children[i++]);
    let healthy = true;
    const fetch = vi.fn(async () => new Response(HEALTHY_BODY, { status: healthy ? 200 : 503 }));
    const handle = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: fetch as never,
      portFile: tmpPortFile(),
      entry: () => ({ command: "node", args: ["x.js"], env: {} }),
      pickPort: async () => 3999,
      isFree: async () => true,
      restartDelayMs: 1,
    });
    healthy = false;
    const first = handle.restart();
    // The relaunch has spawned and is now waiting on /healthz — the window a
    // double-click (or a second open tab) lands in.
    await waitFor(() => spawn.mock.calls.length === 2, "the relaunch");
    await expect(handle.restart()).rejects.toThrow(/already restarting/);
    expect(children[1].kill).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2);
    healthy = true;
    await first;
    expect(handle.status()).toBe("running");
    await handle.stop();
  });

  it("a probe that throws mid-restart does not strand the supervisor in restarting: it gives up, drops the port file, and a later restart recovers", async () => {
    let failPick = false;
    const onGaveUp = vi.fn();
    const children = [fakeChild(), fakeChild(), fakeChild()];
    let i = 0;
    const spawn = vi.fn(() => children[i++]);
    const fetch = vi.fn(async () => new Response(HEALTHY_BODY, { status: 200 }));
    const portFile = tmpPortFile();
    const handle = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: fetch as never,
      portFile,
      entry: () => ({ command: "node", args: ["x.js"], env: {} }),
      pickPort: async () => {
        if (failPick) throw new Error("no free port");
        return 3999;
      },
      // The old port reads as taken, so the restart has to go through the picker.
      isFree: async () => false,
      restartDelayMs: 1,
      onGaveUp,
    });
    failPick = true;
    await expect(handle.restart()).rejects.toThrow(/no free port/);
    // The old child is already dead and nothing replaced it.
    expect(children[0].kill).toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(handle.status()).toBe("gave-up");
    expect(fs.existsSync(portFile)).toBe(false);
    expect(onGaveUp).toHaveBeenCalledTimes(1);

    failPick = false;
    await handle.restart();
    expect(handle.status()).toBe("running");
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(portFile, "utf-8")).toBe("3999");
    await handle.stop();
  });
});

/**
 * The endpoint's port is written into users' own CLI configs, so a restart
 * must not move it for a transient reason, must publish whatever port a child
 * actually goes healthy on, and must never leave two relaunchers each
 * spawning a child. Timing is driven with fake timers and gates, never with
 * sleeps racing the supervisor's own timers.
 */
describe("restart() — port stability and relaunch ownership", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  type Child = ReturnType<typeof fakeChild>;

  async function supervise(opts: {
    children: Child[];
    isFree?: (p: number) => Promise<boolean>;
    pickPort?: () => Promise<number>;
    fetch?: (url: string) => Promise<Response>;
    /** 1-based: the boot spawn is call 1. */
    spawnThrowsOnCall?: number;
    entry?: () => { command: string; args: string[]; env: Record<string, string> };
    maxRestarts?: number;
    healthTimeoutMs?: number;
    portFile?: string;
  }) {
    let i = 0;
    const spawnedPorts: string[] = [];
    const spawn = vi.fn((_cmd: string, _args: string[], o: { env: Record<string, string> }) => {
      if (opts.spawnThrowsOnCall === spawn.mock.calls.length) throw new Error("spawn EAGAIN");
      spawnedPorts.push(o.env.LIBI_MCP_PORT);
      return opts.children[i++];
    });
    const fetch = vi.fn(opts.fetch ?? (async () => new Response(HEALTHY_BODY, { status: 200 })));
    const pickPort = vi.fn(opts.pickPort ?? (async () => 3999));
    const onPortChanged = vi.fn();
    const onGaveUp = vi.fn();
    const portFile = opts.portFile ?? tmpPortFile();
    const handle = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: fetch as never,
      portFile,
      entry: opts.entry ?? (() => ({ command: "node", args: ["x.js"], env: {} })),
      pickPort,
      isFree: opts.isFree ?? (async () => true),
      onPortChanged,
      onGaveUp,
      maxRestarts: opts.maxRestarts ?? 3,
      healthTimeoutMs: opts.healthTimeoutMs ?? 10_000,
      restartDelayMs: 1,
    });
    return { handle, spawn, spawnedPorts, fetch, pickPort, onPortChanged, onGaveUp, portFile };
  }

  it("waits for a stuck child's exit after SIGKILL before probing, and relaunches on the same port", async () => {
    vi.useFakeTimers();
    const old = stuckChild(300);
    // The old child's listening socket holds the port until the process is gone.
    const { handle, spawnedPorts, pickPort, onPortChanged, portFile } = await supervise({
      children: [old, fakeChild()],
      isFree: async () => old.signalCode === "SIGKILL",
      pickPort: vi
        .fn<() => Promise<number>>()
        .mockResolvedValueOnce(3999)
        .mockResolvedValue(4001),
    });

    const p = handle.restart();
    await vi.advanceTimersByTimeAsync(2_000 + 300 + 50);
    await p;

    expect(old.kill).toHaveBeenCalledWith("SIGTERM");
    expect(old.kill).toHaveBeenCalledWith("SIGKILL");
    // Never re-picked: "taken" was only ever the dying child's own socket.
    expect(pickPort).toHaveBeenCalledTimes(1);
    expect(spawnedPorts).toEqual(["3999", "3999"]);
    expect(handle.port).toBe(3999);
    expect(fs.readFileSync(portFile, "utf-8")).toBe("3999");
    expect(onPortChanged).not.toHaveBeenCalled();
    await handle.stop();
  });

  it("re-probes the same port until it frees, and an old child's exit after the relaunch is not counted as a crash", async () => {
    vi.useFakeTimers();
    let portHeld = true;
    const old = fakeChild();
    old.kill = vi.fn((sig?: string) => {
      if (sig === "SIGKILL") {
        // The socket goes 1.2 s after SIGKILL — past the exit wait, inside the
        // re-probe window — and the process itself only exits at 5 s.
        setTimeout(() => (portHeld = false), 1_200);
        setTimeout(() => {
          old.signalCode = "SIGKILL";
          old.emit("exit", null, "SIGKILL");
        }, 5_000);
      }
      return true;
    });
    const fresh = fakeChild();
    const { handle, spawn, pickPort, onGaveUp, portFile } = await supervise({
      children: [old, fresh, fakeChild()],
      isFree: async () => !portHeld,
      pickPort: vi
        .fn<() => Promise<number>>()
        .mockResolvedValueOnce(3999)
        .mockResolvedValue(4001),
      // With no budget at all, an exit counted as a crash gives up at once.
      maxRestarts: 0,
    });

    const p = handle.restart();
    await vi.advanceTimersByTimeAsync(2_000 + 1_000 + 500);
    await p;
    expect(pickPort).toHaveBeenCalledTimes(1);
    expect(handle.port).toBe(3999);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(handle.status()).toBe("running");

    // The old child finally exits, well after its replacement is serving.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(handle.status()).toBe("running");
    expect(onGaveUp).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(portFile, "utf-8")).toBe("3999");
    await handle.stop();
    expect(fresh.kill).toHaveBeenCalled();
  });

  it("a re-picked restart that comes up unhealthy and recovers through the crash path publishes the recovered port and notifies once", async () => {
    vi.useFakeTimers();
    let spawns = 0;
    const children = [fakeChild(), fakeChild(), fakeChild()];
    const env = await supervise({
      children,
      // Someone else holds 3999 for good.
      isFree: async (p) => p !== 3999,
      pickPort: vi
        .fn<() => Promise<number>>()
        .mockResolvedValueOnce(3999)
        .mockResolvedValue(4001),
      // The user restart's relaunch (the second spawn) is wedged; the crash
      // path's relaunch after it is fine.
      fetch: async () => new Response(HEALTHY_BODY, { status: spawns === 2 ? 503 : 200 }),
      healthTimeoutMs: 50,
    });
    env.spawn.mockImplementation(((_c: string, _a: string[], o: { env: Record<string, string> }) => {
      env.spawnedPorts.push(o.env.LIBI_MCP_PORT);
      return children[spawns++];
    }) as never);
    spawns = 1;

    const rejected = expect(env.handle.restart()).rejects.toThrow(/did not become healthy/);
    await vi.advanceTimersByTimeAsync(500 + 200);
    await rejected;
    expect(children[1].kill).toHaveBeenCalledWith("SIGKILL");

    await vi.advanceTimersByTimeAsync(50);
    expect(spawns).toBe(3);
    // Boot, the wedged user relaunch, the crash-path recovery.
    expect(env.spawnedPorts).toEqual(["3999", "4001", "4001"]);
    expect(env.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4001/healthz",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(env.handle.status()).toBe("running");
    expect(env.handle.port).toBe(4001);
    expect(fs.readFileSync(env.portFile, "utf-8")).toBe("4001");
    expect(env.onPortChanged).toHaveBeenCalledTimes(1);
    expect(env.onPortChanged).toHaveBeenCalledWith(4001);
    await env.handle.stop();
  });

  it("a restart that failed after re-picking still notifies when a later restart comes up on the new port", async () => {
    vi.useFakeTimers();
    const env = await supervise({
      children: [fakeChild(), fakeChild()],
      isFree: async (p) => p !== 3999,
      pickPort: vi
        .fn<() => Promise<number>>()
        .mockResolvedValueOnce(3999)
        .mockResolvedValue(4001),
      spawnThrowsOnCall: 2,
    });

    const failed = expect(env.handle.restart()).rejects.toThrow(/EAGAIN/);
    await vi.advanceTimersByTimeAsync(600);
    await failed;
    expect(env.handle.status()).toBe("gave-up");
    expect(fs.existsSync(env.portFile)).toBe(false);
    expect(env.onPortChanged).not.toHaveBeenCalled();

    // 3999 is still taken, so the later restart waits on it for a moment, then re-picks.
    const recovered = env.handle.restart();
    await vi.advanceTimersByTimeAsync(600);
    await recovered;
    expect(env.handle.port).toBe(4001);
    expect(fs.readFileSync(env.portFile, "utf-8")).toBe("4001");
    // 3999 was the last port anyone was told about, so moving off it notifies.
    expect(env.onPortChanged).toHaveBeenCalledTimes(1);
    expect(env.onPortChanged).toHaveBeenCalledWith(4001);
    await env.handle.stop();
  });

  it("a restart after a re-pick whose launch failed goes back to the published port once it is free: the port does not move, and there is nothing to notify", async () => {
    vi.useFakeTimers();
    let taken = true;
    const env = await supervise({
      children: [fakeChild(), fakeChild()],
      isFree: async (p) => !(taken && p === 3999),
      pickPort: vi
        .fn<() => Promise<number>>()
        .mockResolvedValueOnce(3999)
        .mockResolvedValue(4001),
      spawnThrowsOnCall: 2,
    });
    // 3999 is published. A restart finds it taken, re-picks 4001, and that launch fails.
    const failed = expect(env.handle.restart()).rejects.toThrow(/EAGAIN/);
    await vi.advanceTimersByTimeAsync(600);
    await failed;
    expect(env.handle.status()).toBe("gave-up");

    // Whoever held 3999 lets go, and the user restarts.
    taken = false;
    const recovered = env.handle.restart();
    await vi.advanceTimersByTimeAsync(600);
    await recovered;
    // Boot and the recovery; the failed launch threw before it spawned anything.
    expect(env.spawnedPorts).toEqual(["3999", "3999"]);
    expect(env.handle.status()).toBe("running");
    expect(env.handle.port).toBe(3999);
    expect(fs.readFileSync(env.portFile, "utf-8")).toBe("3999");
    // 3999 is what every consumer already holds.
    expect(env.onPortChanged).not.toHaveBeenCalled();
    await env.handle.stop();
  });

  it.each([
    ["the port picker rejects", "pick"],
    ["resolving the launch entry throws", "entry"],
  ] as const)(
    "a crash-path relaunch that fails before a child exists (%s) gives up, drops the port file, and a later restart recovers",
    async (_label, shape) => {
      vi.useFakeTimers();
      const logError = vi.spyOn(serverLogger, "error");
      let failing = false;
      let taken = false;
      const children = [fakeChild(), fakeChild()];
      const env = await supervise({
        children,
        isFree: async () => !taken,
        pickPort: async () => {
          if (failing && shape === "pick") throw new Error("no free port");
          return 3999;
        },
        entry: () => {
          if (failing && shape === "entry") throw new Error("cannot resolve the aggregator entry");
          return { command: "node", args: ["x.js"], env: {} };
        },
      });
      expect(fs.readFileSync(env.portFile, "utf-8")).toBe("3999");

      failing = true;
      // The picker is only consulted when the current port is taken.
      taken = shape === "pick";
      children[0].exitCode = 1;
      children[0].emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(5);

      expect(env.handle.status()).toBe("gave-up");
      expect(fs.existsSync(env.portFile)).toBe(false);
      expect(env.onGaveUp).toHaveBeenCalledTimes(1);
      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({ tag: "mcp-http", op: "child_crash_restart_failed" }),
      );
      expect(env.spawn).toHaveBeenCalledTimes(1);

      failing = false;
      taken = false;
      await env.handle.restart();
      expect(env.handle.status()).toBe("running");
      expect(env.spawn).toHaveBeenCalledTimes(2);
      expect(fs.readFileSync(env.portFile, "utf-8")).toBe("3999");
      await env.handle.stop();
    },
  );

  it("a crash-path relaunch suspended in the port picker yields to a user restart that finished meanwhile: no second child, the port stays", async () => {
    vi.useFakeTimers();
    let taken = true;
    const pick = gate<number>();
    let picks = 0;
    const children = [fakeChild(), fakeChild(), fakeChild()];
    const env = await supervise({
      children,
      isFree: async () => !taken,
      pickPort: async () => (++picks === 1 ? 3999 : pick.wait()),
    });

    // A crash; its relaunch finds the port taken and suspends in the picker.
    children[0].exitCode = 1;
    children[0].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(5);
    await pick.entered;

    // Whoever held the port lets go, and the user restarts in that window.
    taken = false;
    await env.handle.restart();
    expect(env.spawn).toHaveBeenCalledTimes(2);

    // Only now does the crash path's picker answer.
    pick.release(4001);
    await vi.advanceTimersByTimeAsync(50);

    expect(env.spawn).toHaveBeenCalledTimes(2);
    expect(env.handle.port).toBe(3999);
    expect(fs.readFileSync(env.portFile, "utf-8")).toBe("3999");
    expect(env.onPortChanged).not.toHaveBeenCalled();
    expect(env.handle.status()).toBe("running");
    expect(children[1].kill).not.toHaveBeenCalled();
    // The child the user restart launched is the one stop() kills — nothing
    // else was ever spawned to be left behind.
    await env.handle.stop();
    expect(children[1].kill).toHaveBeenCalled();
    expect(env.spawn).toHaveBeenCalledTimes(2);
  });

  it("a user restart's relaunch that dies during its health check is still relaunched by the crash path once the restart has rejected", async () => {
    vi.useFakeTimers();
    const children = [fakeChild(), fakeChild(), fakeChild()];
    let spawned = 1;
    const env = await supervise({
      children,
      fetch: async () => {
        if (spawned === 2) throw new Error("ECONNREFUSED");
        return new Response(HEALTHY_BODY, { status: 200 });
      },
    });
    env.spawn.mockImplementation((() => children[spawned++]) as never);

    // The relaunch itself exits during the health check, so the rejection
    // says it exited (with its code) rather than naming the health window.
    const rejected = expect(env.handle.restart()).rejects.toThrow(/exited before becoming healthy \(code 1\)/);
    // The relaunch dies 10 ms in; its crash-restart timer (1 ms) fires while
    // the user restart is still waiting on /healthz.
    await vi.advanceTimersByTimeAsync(10);
    children[1].exitCode = 1;
    children[1].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(300);
    await rejected;

    expect(spawned).toBe(3);
    expect(env.handle.status()).toBe("running");
    expect(fs.readFileSync(env.portFile, "utf-8")).toBe("3999");
    await env.handle.stop();
  });

  it("a stop() that lands while restart() probes the port wins", async () => {
    const probe = gate<boolean>();
    let gated = false;
    const env = await supervise({
      children: [fakeChild(), fakeChild()],
      isFree: async () => (gated ? probe.wait() : true),
    });
    gated = true;
    const p = env.handle.restart();
    const settled = expect(p).rejects.toThrow(/stopped during restart/);
    await probe.entered;
    await env.handle.stop();
    probe.release(true);
    await settled;
    expect(env.spawn).toHaveBeenCalledTimes(1);
    expect(env.handle.status()).toBe("stopped");
    expect(fs.existsSync(env.portFile)).toBe(false);
  });

  it("a stop() that lands while restart() waits on the port picker wins, and the port does not move", async () => {
    vi.useFakeTimers();
    const pick = gate<number>();
    let picks = 0;
    const env = await supervise({
      children: [fakeChild(), fakeChild()],
      isFree: async () => false,
      pickPort: async () => (++picks === 1 ? 3999 : pick.wait()),
    });
    const settled = expect(env.handle.restart()).rejects.toThrow(/stopped during restart/);
    await vi.advanceTimersByTimeAsync(600);
    await pick.entered;
    await env.handle.stop();
    pick.release(4001);
    await settled;
    expect(env.spawn).toHaveBeenCalledTimes(1);
    expect(env.handle.port).toBe(3999);
    expect(env.onPortChanged).not.toHaveBeenCalled();
    expect(env.handle.status()).toBe("stopped");
    expect(fs.existsSync(env.portFile)).toBe(false);
  });

  it("reads restarting for the whole user restart, health check included", async () => {
    const health = gate<void>();
    let gated = false;
    const env = await supervise({
      children: [fakeChild(), fakeChild()],
      fetch: async () => {
        if (gated) await health.wait();
        return new Response(HEALTHY_BODY, { status: 200 });
      },
    });
    gated = true;
    const p = env.handle.restart();
    await health.entered;
    expect(env.spawn).toHaveBeenCalledTimes(2);
    expect(env.handle.status()).toBe("restarting");
    health.release();
    await p;
    expect(env.handle.status()).toBe("running");
    await env.handle.stop();
  });

  it("a stop() during the relaunch's health check rejects as stopped, not superseded", async () => {
    const health = gate<void>();
    let gated = false;
    const children = [fakeChild(), fakeChild()];
    const env = await supervise({
      children,
      fetch: async () => {
        if (gated) await health.wait();
        return new Response(HEALTHY_BODY, { status: 200 });
      },
    });
    gated = true;
    const settled = expect(env.handle.restart()).rejects.toThrow(/stopped during restart/);
    await health.entered;
    await env.handle.stop();
    health.release();
    await settled;
    expect(children[1].kill).toHaveBeenCalled();
    expect(env.handle.status()).toBe("stopped");
    expect(fs.existsSync(env.portFile)).toBe(false);
  });

  it("a port file that cannot be written does not fail a healthy restart", async () => {
    const env = await supervise({ children: [fakeChild(), fakeChild()] });
    // The directory holding the port file disappears under the running app.
    fs.rmSync(path.dirname(env.portFile), { recursive: true, force: true });
    await expect(env.handle.restart()).resolves.toBeUndefined();
    expect(env.handle.status()).toBe("running");
    expect(env.handle.port).toBe(3999);
    await env.handle.stop();
  });
  it("a crash-path relaunch goes back to the published port once it is free, after an earlier crash relaunch re-picked and came up unhealthy", async () => {
    vi.useFakeTimers();
    let publishedTaken = false;
    const children = Array.from({ length: 6 }, () => fakeChild());
    const env = await supervise({
      children,
      isFree: async (p) => !(publishedTaken && p === 3999),
      pickPort: vi
        .fn<() => Promise<number>>()
        .mockResolvedValueOnce(3999)
        .mockResolvedValue(4001),
      // Whatever launches on the re-picked port comes up wedged.
      fetch: async (url) => new Response(HEALTHY_BODY, { status: url.includes(":4001/") ? 503 : 200 }),
      healthTimeoutMs: 50,
    });
    expect(fs.readFileSync(env.portFile, "utf-8")).toBe("3999");

    // Someone takes 3999 while the child is up, and the child then crashes: the
    // relaunch has to move, and the one it moves to is wedged.
    publishedTaken = true;
    children[0].exitCode = 1;
    children[0].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(5);
    expect(env.spawnedPorts).toEqual(["3999", "4001"]);
    // Every URL still names the published port: the move is not real until a
    // child is healthy on it.
    expect(env.handle.port).toBe(4001);
    expect(env.handle.advertisedPort).toBe(3999);

    // 3999 frees while that relaunch is still failing its health check.
    publishedTaken = false;
    await vi.advanceTimersByTimeAsync(300);

    // The next relaunch returns to the port every registration names, not the
    // one nothing was ever published on.
    expect(env.spawnedPorts).toEqual(["3999", "4001", "3999"]);
    expect(env.handle.status()).toBe("running");
    expect(env.handle.port).toBe(3999);
    expect(fs.readFileSync(env.portFile, "utf-8")).toBe("3999");
    expect(env.onPortChanged).not.toHaveBeenCalled();
    await env.handle.stop();
  });
});

/**
 * Node reports a child that could not be spawned (ENOENT, EACCES, EAGAIN,
 * EMFILE) as an ASYNC `error` event on the ChildProcess and never emits `exit`
 * for it. Unlistened, that event is an uncaught exception in the libi server;
 * listened to but not supervised, the aggregator reads `running` behind a stale
 * port file. The fakes keep `exitCode` null (Node sets it negative), so the
 * supervisor is proven not to depend on that detail.
 */
describe("a child that fails to spawn", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  type Child = ReturnType<typeof fakeChild>;

  function spawnError(code: "ENOENT" | "EACCES" | "EAGAIN" = "ENOENT"): NodeJS.ErrnoException {
    return Object.assign(new Error(`spawn node ${code}`), { code, errno: -2, syscall: "spawn node", path: "node" });
  }

  async function supervise(opts: {
    children: Child[];
    fetch?: (url: string) => Promise<Response>;
    maxRestarts?: number;
  }) {
    let i = 0;
    const spawnedPorts: string[] = [];
    const spawn = vi.fn((_cmd: string, _args: string[], o: { env: Record<string, string> }) => {
      spawnedPorts.push(o.env.LIBI_MCP_PORT);
      return opts.children[i++];
    });
    const onPortChanged = vi.fn();
    const onGaveUp = vi.fn();
    const portFile = tmpPortFile();
    const handle = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: (opts.fetch ?? (async () => new Response(HEALTHY_BODY, { status: 200 }))) as never,
      portFile,
      entry: () => ({ command: "node", args: ["x.js"], env: {} }),
      pickPort: async () => 3999,
      isFree: async () => true,
      onPortChanged,
      onGaveUp,
      maxRestarts: opts.maxRestarts ?? 3,
      healthTimeoutMs: 10_000,
      restartDelayMs: 1,
    });
    return { handle, spawn, spawnedPorts, onPortChanged, onGaveUp, portFile };
  }

  it("on the first launch: the error is handled rather than thrown, and the launch ends gave-up without waiting out the health timeout", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(serverLogger, "warn");
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const portFile = tmpPortFile();
    let outcome: McpHttpChildHandle | Error | undefined;
    void startMcpHttpChild({
      spawn: spawn as never,
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as never,
      portFile,
      entry: () => ({ command: "node", args: ["x.js"], env: {} }),
      pickPort: async () => 3999,
      isFree: async () => true,
      healthTimeoutMs: 10_000,
      restartDelayMs: 1,
    }).then(
      (handle) => (outcome = handle),
      (err: Error) => (outcome = err),
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(spawn).toHaveBeenCalledTimes(1);

    expect(() => child.emit("error", spawnError())).not.toThrow();
    await vi.advanceTimersByTimeAsync(250);
    expect(outcome).toBeDefined();
    expect(outcome).not.toBeInstanceOf(Error);
    expect((outcome as McpHttpChildHandle).status()).toBe("gave-up");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "mcp-http", op: "child_spawn_error", code: "ENOENT" }),
    );
    expect(fs.existsSync(portFile)).toBe(false);
    // A launch that gave up waits for a restart: the crash timer the failure armed never relaunches.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("crash-path relaunches that all fail to spawn spend the restart budget like exits do, then give up and drop the port file", async () => {
    vi.useFakeTimers();
    let refusing = false;
    const children = Array.from({ length: 6 }, () => fakeChild());
    const env = await supervise({
      children,
      fetch: async () => {
        if (refusing) throw new Error("ECONNREFUSED");
        return new Response(HEALTHY_BODY, { status: 200 });
      },
      maxRestarts: 3,
    });
    expect(fs.readFileSync(env.portFile, "utf-8")).toBe("3999");

    refusing = true;
    children[0].exitCode = 1;
    children[0].emit("exit", 1, null);
    for (const idx of [1, 2, 3]) {
      await vi.advanceTimersByTimeAsync(20);
      expect(env.spawn).toHaveBeenCalledTimes(idx + 1);
      expect(() => children[idx].emit("error", spawnError())).not.toThrow();
    }
    await vi.advanceTimersByTimeAsync(20);

    expect(env.handle.status()).toBe("gave-up");
    expect(fs.existsSync(env.portFile)).toBe(false);
    expect(env.onGaveUp).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(env.spawn).toHaveBeenCalledTimes(4);
    // A child that never existed is never signalled.
    for (const idx of [1, 2, 3]) expect(children[idx].kill).not.toHaveBeenCalled();
  });

  it("a crash-path relaunch that fails to spawn is handled like its exit: the next relaunch comes up and the port stays published", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(serverLogger, "warn");
    let refusing = false;
    const children = [fakeChild(), fakeChild(), fakeChild()];
    const env = await supervise({
      children,
      fetch: async () => {
        if (refusing) throw new Error("ECONNREFUSED");
        return new Response(HEALTHY_BODY, { status: 200 });
      },
    });

    refusing = true;
    children[0].exitCode = 1;
    children[0].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(5);
    expect(env.spawn).toHaveBeenCalledTimes(2);
    expect(() => children[1].emit("error", spawnError())).not.toThrow();
    refusing = false;
    await vi.advanceTimersByTimeAsync(300);

    expect(env.spawn).toHaveBeenCalledTimes(3);
    expect(env.spawnedPorts).toEqual(["3999", "3999", "3999"]);
    expect(env.handle.status()).toBe("running");
    expect(fs.readFileSync(env.portFile, "utf-8")).toBe("3999");
    expect(env.onGaveUp).not.toHaveBeenCalled();
    expect(env.onPortChanged).not.toHaveBeenCalled();
    expect(children[1].kill).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "mcp-http", op: "child_spawn_error", code: "ENOENT" }),
    );
    await env.handle.stop();
  });

  it("a user restart whose relaunch fails to spawn rejects as unhealthy, ends gave-up with no port file, and a later restart recovers", async () => {
    vi.useFakeTimers();
    let refusing = false;
    const children = [fakeChild(), fakeChild(), fakeChild()];
    const env = await supervise({
      children,
      fetch: async () => {
        if (refusing) throw new Error("ECONNREFUSED");
        return new Response(HEALTHY_BODY, { status: 200 });
      },
      // No budget: the failed relaunch is counted, exactly as an unhealthy one is.
      maxRestarts: 0,
    });

    refusing = true;
    // A relaunch that never spawned counts as already exited too, with no
    // code or signal to report.
    const rejected = expect(env.handle.restart()).rejects.toThrow(/exited before becoming healthy/);
    await vi.advanceTimersByTimeAsync(5);
    expect(env.spawn).toHaveBeenCalledTimes(2);
    expect(() => children[1].emit("error", spawnError("EACCES"))).not.toThrow();
    await vi.advanceTimersByTimeAsync(200);
    await rejected;

    expect(env.handle.status()).toBe("gave-up");
    expect(fs.existsSync(env.portFile)).toBe(false);
    expect(env.onGaveUp).toHaveBeenCalledTimes(1);
    expect(children[1].kill).not.toHaveBeenCalled();

    refusing = false;
    const recovered = env.handle.restart();
    await vi.advanceTimersByTimeAsync(600);
    await recovered;
    expect(env.handle.status()).toBe("running");
    expect(env.spawn).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(env.portFile, "utf-8")).toBe("3999");
    expect(env.onPortChanged).not.toHaveBeenCalled();
    await env.handle.stop();
  });

  it("an `error` followed by an `exit` from the same child is counted once", async () => {
    vi.useFakeTimers();
    const children = [fakeChild(), fakeChild(), fakeChild()];
    // One failure's worth of budget: counting this child twice gives up.
    const env = await supervise({ children, maxRestarts: 1 });

    expect(() => children[0].emit("error", spawnError("EAGAIN"))).not.toThrow();
    children[0].exitCode = 1;
    children[0].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(50);

    expect(env.handle.status()).toBe("running");
    expect(env.onGaveUp).not.toHaveBeenCalled();
    expect(env.spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(env.spawn).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(env.portFile, "utf-8")).toBe("3999");
    await env.handle.stop();
  });

  it("an `error` from a child that has already been replaced is ignored", async () => {
    vi.useFakeTimers();
    // Ignores every signal, so its `exit` never arrives to be accounted first.
    const old = fakeChild();
    old.kill = vi.fn(() => true);
    const fresh = fakeChild();
    const env = await supervise({ children: [old, fresh, fakeChild()], maxRestarts: 0 });

    const p = env.handle.restart();
    await vi.advanceTimersByTimeAsync(2_000 + 1_000 + 50);
    await p;
    expect(env.spawn).toHaveBeenCalledTimes(2);

    expect(() => old.emit("error", spawnError())).not.toThrow();
    await vi.advanceTimersByTimeAsync(500);

    // With no budget at all, counting it would have given up at once.
    expect(env.handle.status()).toBe("running");
    expect(env.onGaveUp).not.toHaveBeenCalled();
    expect(env.spawn).toHaveBeenCalledTimes(2);
    expect(fresh.kill).not.toHaveBeenCalled();
    expect(fs.readFileSync(env.portFile, "utf-8")).toBe("3999");
    await env.handle.stop();
  });

  it("an `error` from a signal that could not be delivered to a live child is logged, not mistaken for its death", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(serverLogger, "warn");
    const children = [fakeChild(), fakeChild()];
    const env = await supervise({ children, maxRestarts: 0 });

    const eperm = Object.assign(new Error("kill EPERM"), { code: "EPERM", errno: -1, syscall: "kill" });
    expect(() => children[0].emit("error", eperm)).not.toThrow();
    await vi.advanceTimersByTimeAsync(500);

    expect(env.handle.status()).toBe("running");
    expect(env.spawn).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(env.portFile, "utf-8")).toBe("3999");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "mcp-http", op: "child_kill_error", code: "EPERM" }),
    );
    await env.handle.stop();
  });
});

describe("a first launch that is slow, or never answers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Secret-shaped values a child could echo: a bearer token, and a value the
  // supervisor handed it in its own environment.
  const FAKE_BEARER = "sk-fake-0123456789abcdefghijklmnop";
  const FAKE_ENV_SECRET = "fal-fake-env-value-0123456789";

  /** `/healthz` refuses until `up()` holds. */
  const healthWhen = (up: () => boolean) =>
    vi.fn(async () => {
      if (!up()) throw new Error("ECONNREFUSED");
      return new Response(HEALTHY_BODY, { status: 200 });
    });

  /** Settlement you can inspect while fake timers hold the promise open. */
  function track<T>(p: Promise<T>) {
    const s: { value?: T; error?: Error; settled: boolean } = { settled: false };
    p.then(
      (value) => Object.assign(s, { value, settled: true }),
      (error: Error) => Object.assign(s, { error, settled: true }),
    );
    return s;
  }

  it("gets 30 s, not 10: a child still silent at 10 s that answers at 15 s comes up running", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const portFile = tmpPortFile();
    const t0 = Date.now();
    const start = track(
      startMcpHttpChild({
        spawn: (() => child) as never,
        fetch: healthWhen(() => Date.now() - t0 >= 15_000) as never,
        portFile,
        entry: () => ({ command: "node", args: ["x.js"], env: {} }),
        pickPort: async () => 3999,
        isFree: async () => true,
      }),
    );
    await vi.advanceTimersByTimeAsync(10_500);
    expect(start.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(start.error).toBeUndefined();
    expect(start.value?.status()).toBe("running");
    expect(fs.readFileSync(portFile, "utf-8")).toBe("3999");
    expect(child.kill).not.toHaveBeenCalled();
    await start.value!.stop();
  });

  it("never answering resolves a gave-up handle with no port file, reports the child's scrubbed output, and a restart then brings it up and publishes the port", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(serverLogger, "warn");
    const children = [fakeChild(), fakeChild()];
    let i = 0;
    const spawnedPorts: string[] = [];
    const spawn = vi.fn((_cmd: string, _args: string[], o: { env: Record<string, string> }) => {
      spawnedPorts.push(o.env.LIBI_MCP_PORT);
      return children[i++];
    });
    let up = false;
    const onGaveUp = vi.fn();
    const onPortChanged = vi.fn();
    const portFile = tmpPortFile();
    // Left behind by an earlier run: nothing of ours is listening there.
    fs.writeFileSync(portFile, "4555");
    const start = track(
      startMcpHttpChild({
        spawn: spawn as never,
        fetch: healthWhen(() => up) as never,
        portFile,
        entry: () => ({ command: "node", args: ["x.js"], env: { FAL_KEY: FAKE_ENV_SECRET } }),
        pickPort: async () => 3999,
        isFree: async () => true,
        onGaveUp,
        onPortChanged,
      }),
    );
    await vi.advanceTimersByTimeAsync(1);
    children[0].stderr.emit("data", Buffer.from("loading 32 skills\n"));
    children[0].stderr.emit(
      "data",
      Buffer.from(`upstream said: Authorization: Bearer ${FAKE_BEARER}\nFAL_KEY is ${FAKE_ENV_SECRET}\n`),
    );
    await vi.advanceTimersByTimeAsync(29_000);
    // Still inside the first-launch window.
    expect(start.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(start.error).toBeUndefined();
    const handle = start.value!;
    expect(handle.status()).toBe("gave-up");
    expect(fs.existsSync(portFile)).toBe(false);
    expect(children[0].kill).toHaveBeenCalledWith("SIGKILL");

    const outputLog = warn.mock.calls.find(([o]) => (o as { op?: string }).op === "child_unhealthy_output");
    expect(outputLog).toBeDefined();
    const logged = JSON.stringify(outputLog);
    expect(logged).toContain("loading 32 skills");
    expect(logged).not.toContain(FAKE_BEARER);
    expect(logged).not.toContain(FAKE_ENV_SECRET);

    expect(onGaveUp).toHaveBeenCalledTimes(1);
    const err = onGaveUp.mock.calls[0][0] as Error;
    expect(err.message).toMatch(/did not become healthy within 30000ms/);
    expect(err.message).toContain("loading 32 skills");
    expect(err.message).not.toContain(FAKE_BEARER);
    expect(err.message).not.toContain(FAKE_ENV_SECRET);

    // The libi MCP tab's Restart button, once the machine has calmed down.
    up = true;
    const restarted = track(handle.restart());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(restarted.error).toBeUndefined();
    expect(restarted.settled).toBe(true);
    expect(handle.status()).toBe("running");
    expect(spawnedPorts).toEqual(["3999", "3999"]);
    expect(handle.port).toBe(3999);
    expect(fs.readFileSync(portFile, "utf-8")).toBe("3999");
    // Configs built while nothing was published named a fallback URL; the
    // recovery has to rebuild them.
    expect(onPortChanged).toHaveBeenCalledWith(3999);
    await handle.stop();
    expect(handle.status()).toBe("stopped");
  });

  it("a relaunch keeps the 10 s window, and its failure carries the relaunched child's output", async () => {
    vi.useFakeTimers();
    const children = [fakeChild(), fakeChild()];
    let i = 0;
    let up = true;
    const handle = await startMcpHttpChild({
      spawn: (() => children[i++]) as never,
      fetch: healthWhen(() => up) as never,
      portFile: tmpPortFile(),
      entry: () => ({ command: "node", args: ["x.js"], env: {} }),
      pickPort: async () => 3999,
      isFree: async () => true,
      maxRestarts: 0,
    });
    up = false;
    const restarted = track(handle.restart());
    await vi.advanceTimersByTimeAsync(1);
    children[1].stderr.emit("data", Buffer.from("Error: listen EACCES 127.0.0.1:3999\n"));
    await vi.advanceTimersByTimeAsync(9_500);
    expect(restarted.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(700);
    expect(restarted.error?.message).toMatch(/did not become healthy within 10000ms/);
    expect(restarted.error?.message).toContain("listen EACCES");
    expect(handle.status()).toBe("gave-up");
  });
});

/** Settlement you can inspect while fake timers hold a promise open. */
function settle<T>(p: Promise<T>) {
  const s: { value?: T; error?: Error; settled: boolean } = { settled: false };
  p.then(
    (value) => Object.assign(s, { value, settled: true }),
    (error: Error) => Object.assign(s, { error, settled: true }),
  );
  return s;
}

const plainEntry = () => ({ command: "node", args: ["x.js"], env: {} });

describe("each /healthz attempt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Settles only when the attempt is aborted, as a request to a listener that accepts and never answers does. */
  const pendingUntilAborted = (init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });

  it("ends when its child exits rather than at its own cap, so a child that could not bind is reported at once inside a long window", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => {
      setTimeout(() => {
        child.exitCode = 1;
        child.emit("exit", 1, null);
      }, 50);
      return child;
    });
    const onGaveUp = vi.fn();
    const started = Date.now();
    const outcome = await within(
      startMcpHttpChild({
        spawn: spawn as never,
        fetch: vi.fn((_url: string, init?: { signal?: AbortSignal }) => pendingUntilAborted(init)) as never,
        portFile: tmpPortFile(),
        entry: plainEntry,
        pickPort: async () => 3999,
        isFree: async () => false,
        firstHealthTimeoutMs: 30_000,
        healthAttemptTimeoutMs: 20_000,
        onGaveUp,
      }),
      3_000,
    );
    expect(outcome).not.toBe("still waiting");
    expect((outcome as McpHttpChildHandle).status()).toBe("gave-up");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect((onGaveUp.mock.calls[0][0] as Error).message).toMatch(/exited before becoming healthy \(code 1\)/);
  });

  it("gives up at the injected cap and asks again, so a child whose first answer was lost still comes up well inside its window", async () => {
    const child = fakeChild();
    let calls = 0;
    const fetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      calls++;
      if (calls === 1) return pendingUntilAborted(init);
      return Promise.resolve(new Response(HEALTHY_BODY, { status: 200 }));
    });
    const started = Date.now();
    const outcome = await within(
      startMcpHttpChild({
        spawn: (() => child) as never,
        fetch: fetch as never,
        portFile: tmpPortFile(),
        entry: plainEntry,
        pickPort: async () => 3999,
        isFree: async () => true,
        firstHealthTimeoutMs: 5_000,
        healthAttemptTimeoutMs: 150,
      }),
      3_000,
    );
    expect(outcome).not.toBe("still waiting");
    const handle = outcome as McpHttpChildHandle;
    expect(handle.status()).toBe("running");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(child.kill).not.toHaveBeenCalled();
    await handle.stop();
  });

  it("an answer slower than the poll interval but inside the cap is accepted on that same attempt", async () => {
    const child = fakeChild();
    const fetch = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response(HEALTHY_BODY, { status: 200 })), 100);
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(init.signal?.reason);
            },
            { once: true },
          );
        }),
    );
    const handle = await startMcpHttpChild({
      spawn: (() => child) as never,
      fetch: fetch as never,
      portFile: tmpPortFile(),
      entry: plainEntry,
      pickPort: async () => 3999,
      isFree: async () => true,
      firstHealthTimeoutMs: 2_000,
      healthAttemptTimeoutMs: 300,
    });
    expect(handle.status()).toBe("running");
    expect(fetch).toHaveBeenCalledTimes(1);
    await handle.stop();
  });

  it("an attempt cut off while reading the body is not counted as another process answering, so the launch keeps its port", async () => {
    const warn = vi.spyOn(serverLogger, "warn");
    const child = fakeChild();
    const pickPort = vi.fn(async () => 3999);
    // Headers arrive, then the body stalls until the attempt ends.
    const fetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":true,"healthTo'));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    const outcome = await within(
      startMcpHttpChild({
        spawn: (() => child) as never,
        fetch: fetch as never,
        portFile: tmpPortFile(),
        entry: plainEntry,
        pickPort,
        isFree: async () => true,
        firstHealthTimeoutMs: 400,
        healthAttemptTimeoutMs: 100,
      }),
      3_000,
    );
    expect(outcome).not.toBe("still waiting");
    expect((outcome as McpHttpChildHandle).status()).toBe("gave-up");
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
    expect(warn.mock.calls.filter(([o]) => (o as { op?: string }).op === "health_foreign_answer")).toHaveLength(0);
    // A foreign answer would have moved a failed first launch to a port nothing answers on.
    expect(pickPort).toHaveBeenCalledTimes(1);
  });
});

describe("which /healthz answer is this launch's own", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a 200 without this launch's token, or with an earlier launch's, never publishes; the child's own echo does, and no token reaches a log", async () => {
    vi.useFakeTimers();
    const logged = [
      vi.spyOn(serverLogger, "debug"),
      vi.spyOn(serverLogger, "info"),
      vi.spyOn(serverLogger, "warn"),
      vi.spyOn(serverLogger, "error"),
    ];
    const children = [fakeChild(), fakeChild()];
    const tokens: string[] = [];
    let i = 0;
    const spawn = vi.fn((_c: string, _a: string[], o: { env: Record<string, string> }) => {
      tokens.push(o.env.LIBI_MCP_HEALTH_TOKEN);
      return children[i++];
    });
    // Another libi instance's aggregator answers on the port first.
    let answer: "foreign" | "stale" | "own" = "foreign";
    const fetch = vi.fn(async () => {
      const healthToken = answer === "own" ? tokens[tokens.length - 1] : answer === "stale" ? tokens[0] : undefined;
      return new Response(JSON.stringify({ ok: true, version: "other", healthToken }), { status: 200 });
    });
    const portFile = tmpPortFile();
    const start = settle(
      startSupervisor({
        spawn: spawn as never,
        fetch: fetch as never,
        portFile,
        entry: plainEntry,
        pickPort: async () => 3999,
        isFree: async () => true,
        killTree: (c, s) => {
          c.kill(s);
        },
        signalGroup: () => {},
        healthTimeoutMs: 1_000,
      }),
    );
    await vi.advanceTimersByTimeAsync(1);
    // A child that prints its own token must not put it in the failure report.
    children[0].stderr.emit("data", Buffer.from(`health token ${tokens[0]}\n`));
    await vi.advanceTimersByTimeAsync(1_500);
    const handle = start.value!;
    expect(handle.status()).toBe("gave-up");
    expect(fs.existsSync(portFile)).toBe(false);
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
    const foreign = logged[2].mock.calls.filter(([o]) => (o as { op?: string }).op === "health_foreign_answer");
    expect(foreign).toHaveLength(1);

    // The relaunch first hears the earlier launch's token, which is no better.
    answer = "stale";
    const restarted = settle(handle.restart());
    await vi.advanceTimersByTimeAsync(700);
    expect(restarted.settled).toBe(false);
    expect(fs.existsSync(portFile)).toBe(false);
    answer = "own";
    await vi.advanceTimersByTimeAsync(200);
    expect(restarted.error).toBeUndefined();
    expect(handle.status()).toBe("running");
    expect(fs.readFileSync(portFile, "utf-8")).toBe("3999");

    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(tokens[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(tokens[1]).not.toBe(tokens[0]);
    const allLogs = JSON.stringify(logged.flatMap((s) => s.mock.calls));
    for (const t of tokens) expect(allLogs).not.toContain(t);
    await handle.stop();
  });

  it("an answer that lands after the child died is not accepted, even carrying the right token", async () => {
    const child = fakeChild();
    const fetch = vi.fn(async () => {
      // The child dies while its request is out; then the answer arrives.
      child.exitCode = 1;
      child.emit("exit", 1, null);
      return new Response(HEALTHY_BODY, { status: 200 });
    });
    const portFile = tmpPortFile();
    const handle = await startMcpHttpChild({
      spawn: (() => child) as never,
      fetch: fetch as never,
      portFile,
      entry: plainEntry,
      pickPort: async () => 3999,
      isFree: async () => true,
      healthTimeoutMs: 200,
      maxRestarts: 0,
    });
    expect(handle.status()).toBe("gave-up");
    expect(fs.existsSync(portFile)).toBe(false);
  });
});

describe("the first launch's window, and a restart after it gave up", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("hands out the handle before the health wait, so a stop inside the window kills the child and the launch ends stopped rather than gave-up", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const killTree = vi.fn((c: ChildProcess, s: "SIGTERM" | "SIGKILL") => {
      c.kill(s);
    });
    const onGaveUp = vi.fn();
    const portFile = tmpPortFile();
    let early: McpHttpChildHandle | undefined;
    const start = settle(
      startMcpHttpChild({
        spawn: (() => child) as never,
        fetch: (async () => {
          throw new Error("ECONNREFUSED");
        }) as never,
        portFile,
        entry: plainEntry,
        pickPort: async () => 3999,
        isFree: async () => true,
        killTree,
        onGaveUp,
        onHandle: (h) => (early = h),
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(start.settled).toBe(false);
    expect(early).toBeDefined();
    // The first launch owns relaunching until it settles.
    await expect(early!.restart()).rejects.toThrow(/still starting/);

    // libi quits while the child is still coming up.
    await early!.stop();
    expect(killTree).toHaveBeenCalledWith(child, "SIGTERM");
    await vi.advanceTimersByTimeAsync(200);
    expect(start.settled).toBe(true);
    expect(start.value).toBe(early);
    expect(early!.status()).toBe("stopped");
    expect(onGaveUp).not.toHaveBeenCalled();
    expect(fs.existsSync(portFile)).toBe(false);
  });

  it("a restart after a first launch gave up on a fallback port asks the picker afresh, so it returns to the default once that is free", async () => {
    vi.useFakeTimers();
    const children = [fakeChild(), fakeChild(), fakeChild()];
    let i = 0;
    const spawnedPorts: string[] = [];
    const spawn = vi.fn((_c: string, _a: string[], o: { env: Record<string, string> }) => {
      spawnedPorts.push(o.env.LIBI_MCP_PORT);
      const c = children[i++];
      if (i === 1) {
        // The default was taken by the time the first child tried to bind.
        c.exitCode = 1;
        setTimeout(() => c.emit("exit", 1, null), 0);
      }
      return c;
    });
    // Only a child on the default, launched by the restart, ever answers.
    const fetch = vi.fn(async (url: string) => {
      if (i === 3 && url.includes(`:${DEFAULT_MCP_PORT}/`)) return new Response(HEALTHY_BODY, { status: 200 });
      throw new Error("ECONNREFUSED");
    });
    let defaultTaken = true;
    const picks = [DEFAULT_MCP_PORT, 3501, DEFAULT_MCP_PORT];
    const onPortChanged = vi.fn();
    const portFile = tmpPortFile();
    const start = settle(
      startMcpHttpChild({
        spawn: spawn as never,
        fetch: fetch as never,
        portFile,
        entry: plainEntry,
        pickPort: async () => picks.shift()!,
        isFree: async (p) => !(defaultTaken && p === DEFAULT_MCP_PORT),
        onPortChanged,
        healthTimeoutMs: 1_000,
      }),
    );
    await vi.advanceTimersByTimeAsync(2_500);
    const handle = start.value!;
    expect(handle.status()).toBe("gave-up");
    expect(spawnedPorts).toEqual([String(DEFAULT_MCP_PORT), "3501"]);

    defaultTaken = false;
    const restarted = settle(handle.restart());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(restarted.error).toBeUndefined();
    expect(restarted.settled).toBe(true);
    expect(spawnedPorts).toEqual([String(DEFAULT_MCP_PORT), "3501", String(DEFAULT_MCP_PORT)]);
    expect(handle.status()).toBe("running");
    expect(fs.readFileSync(portFile, "utf-8")).toBe(String(DEFAULT_MCP_PORT));
    expect(onPortChanged).toHaveBeenCalledWith(DEFAULT_MCP_PORT);
    await handle.stop();
  });
});

describe("what a signal to the child reaches", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns a wrapper child as its own process group off Windows, with a stdin pipe it never writes to, and the never-healthy kill goes through its tree", async () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const killTree = vi.fn((c: ChildProcess, s: "SIGTERM" | "SIGKILL") => {
      c.kill(s);
    });
    const handle = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as never,
      portFile: tmpPortFile(),
      entry: plainEntry,
      pickPort: async () => 3999,
      isFree: async () => true,
      killTree,
      healthTimeoutMs: 50,
    });
    expect(handle.status()).toBe("gave-up");
    expect((spawn.mock.calls[0] as unknown[])[2]).toMatchObject({ detached: true, stdio: ["pipe", "pipe", "pipe"] });
    expect(killTree).toHaveBeenCalledWith(child, "SIGKILL");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("keeps the compiled entry, a single process, in libi's own group, still with the stdin pipe", async () => {
    vi.spyOn(os, "platform").mockReturnValue("linux");
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const signalGroup = vi.fn();
    const handle = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: (async () => new Response(HEALTHY_BODY, { status: 200 })) as never,
      portFile: tmpPortFile(),
      entry: () => ({ ...plainEntry(), mode: "compiled" as const }),
      pickPort: async () => 3999,
      isFree: async () => true,
      signalGroup,
    });
    expect((spawn.mock.calls[0] as unknown[])[2]).toMatchObject({ detached: false, stdio: ["pipe", "pipe", "pipe"] });
    await handle.stop();
    // It leads no group, so its exit signals none.
    expect(signalGroup).not.toHaveBeenCalled();
  });

  it("signals what is left of a wrapper's group the moment the wrapper exits, however it exited, and only once", async () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    const children = [fakeChild(), fakeChild()];
    children[0].pid = 5001;
    children[1].pid = 5002;
    let i = 0;
    const signalGroup = vi.fn();
    const handle = await startMcpHttpChild({
      spawn: (() => children[i++]) as never,
      fetch: (async () => new Response(HEALTHY_BODY, { status: 200 })) as never,
      portFile: tmpPortFile(),
      entry: () => ({ ...plainEntry(), mode: "tsx" as const }),
      pickPort: async () => 3999,
      isFree: async () => true,
      restartDelayMs: 1,
      signalGroup,
    });
    expect(signalGroup).not.toHaveBeenCalled();
    // Something killed the wrapper alone; its grandchild would still be serving.
    children[0].signalCode = "SIGKILL";
    children[0].emit("exit", null, "SIGKILL");
    expect(signalGroup).toHaveBeenCalledTimes(1);
    expect(signalGroup).toHaveBeenCalledWith(5001, "SIGTERM");
    await waitFor(() => i === 2 && handle.status() === "running", "the crash relaunch");
    // A stop's own kill is an exit too: the relaunched wrapper's group is swept as well.
    await handle.stop();
    expect(signalGroup).toHaveBeenLastCalledWith(5002, "SIGTERM");
    expect(signalGroup).toHaveBeenCalledTimes(2);
    // Stopping again, long after, signals no group: its id may belong to someone else by now.
    await handle.stop();
    expect(signalGroup).toHaveBeenCalledTimes(2);
  });

  it("does not detach on Windows, where there is no process group to lead", async () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const handle = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: (async () => new Response(HEALTHY_BODY, { status: 200 })) as never,
      portFile: tmpPortFile(),
      entry: plainEntry,
      pickPort: async () => 3999,
      isFree: async () => true,
    });
    expect((spawn.mock.calls[0] as unknown[])[2]).toMatchObject({ detached: false });
    await handle.stop();
  });
});

describe("signalChildTree", () => {
  const withPid = (pid: number | undefined) => {
    const c = fakeChild();
    c.pid = pid as number;
    return c;
  };
  const errno = (code: string) => Object.assign(new Error(`kill ${code}`), { code });

  it("signals the child's whole process group on POSIX", () => {
    const c = withPid(4242);
    const kill = vi.fn();
    signalChildTree(c as never, "SIGKILL", { windows: false, kill });
    expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
    expect(c.kill).not.toHaveBeenCalled();
  });

  it("falls back to the child itself when its group cannot be signalled, but not when the group left with the child", () => {
    const gone = withPid(4242);
    gone.exitCode = 0;
    signalChildTree(gone as never, "SIGTERM", {
      windows: false,
      kill: () => {
        throw errno("ESRCH");
      },
    });
    expect(gone.kill).not.toHaveBeenCalled();

    const notALeader = withPid(4243);
    signalChildTree(notALeader as never, "SIGTERM", {
      windows: false,
      kill: () => {
        throw errno("ESRCH");
      },
    });
    expect(notALeader.kill).toHaveBeenCalledWith("SIGTERM");

    const denied = withPid(4244);
    signalChildTree(denied as never, "SIGKILL", {
      windows: false,
      kill: () => {
        throw errno("EPERM");
      },
    });
    expect(denied.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("walks the tree with the system's own taskkill on Windows, and signals the child itself if taskkill cannot run", () => {
    const c = withPid(4242);
    const taskkill = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const spawn = vi.fn(() => taskkill);
    signalChildTree(c as never, "SIGTERM", { windows: true, spawn: spawn as never, systemRoot: "D:\\WINNT" });
    expect(spawn).toHaveBeenCalledWith(
      "D:\\WINNT\\System32\\taskkill.exe",
      ["/T", "/F", "/PID", "4242"],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(c.kill).not.toHaveBeenCalled();
    taskkill.emit("error", new Error("spawn taskkill ENOENT"));
    expect(c.kill).toHaveBeenCalledWith("SIGTERM");
    // An `exit` after the `error` does not signal it twice.
    taskkill.emit("exit", 1, null);
    expect(c.kill).toHaveBeenCalledTimes(1);
  });

  it("signals the child itself when taskkill runs and fails, but not when it succeeds or the child is already gone", () => {
    const spawnTaskkill = () => {
      const taskkill = Object.assign(new EventEmitter(), { unref: vi.fn() });
      return { taskkill, spawn: vi.fn(() => taskkill) };
    };

    const denied = withPid(4242);
    const a = spawnTaskkill();
    signalChildTree(denied as never, "SIGKILL", { windows: true, spawn: a.spawn as never });
    a.taskkill.emit("exit", 1, null);
    expect(denied.kill).toHaveBeenCalledWith("SIGKILL");

    const killed = withPid(4243);
    const b = spawnTaskkill();
    signalChildTree(killed as never, "SIGKILL", { windows: true, spawn: b.spawn as never });
    b.taskkill.emit("exit", 0, null);
    expect(killed.kill).not.toHaveBeenCalled();

    const raced = withPid(4244);
    const d = spawnTaskkill();
    signalChildTree(raced as never, "SIGKILL", { windows: true, spawn: d.spawn as never });
    raced.exitCode = 1;
    d.taskkill.emit("exit", 128, null);
    expect(raced.kill).not.toHaveBeenCalled();
  });

  it("finds taskkill under %SystemRoot%, or the default Windows folder when that is unset", () => {
    expect(taskkillPath("C:\\Windows")).toBe("C:\\Windows\\System32\\taskkill.exe");
    expect(taskkillPath("")).toBe("C:\\Windows\\System32\\taskkill.exe");
  });

  it("signals only the handle of a child that never spawned", () => {
    const c = withPid(undefined);
    const kill = vi.fn();
    signalChildTree(c as never, "SIGKILL", { windows: false, kill });
    expect(kill).not.toHaveBeenCalled();
    expect(c.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

describe("which answer the handle owns, and where a first launch that only heard others ends", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("owns only the current child's own echo, not an earlier launch's while a crash relaunch is on its way, nor any answer once the child is gone", async () => {
    vi.useFakeTimers();
    const children = [fakeChild(), fakeChild()];
    const tokens: string[] = [];
    let i = 0;
    const spawn = vi.fn((_c: string, _a: string[], o: { env: Record<string, string> }) => {
      tokens.push(o.env.LIBI_MCP_HEALTH_TOKEN);
      return children[i++];
    });
    let relaunchAnswers = false;
    const fetch = vi.fn(async () => {
      if (i === 2 && !relaunchAnswers) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ ok: true, healthToken: tokens[tokens.length - 1] }), { status: 200 });
    });
    let n = 0;
    const start = settle(
      startSupervisor({
        spawn: spawn as never,
        fetch: fetch as never,
        portFile: tmpPortFile(),
        entry: plainEntry,
        pickPort: async () => 3999,
        isFree: async () => true,
        killTree: (c, s) => {
          c.kill(s);
        },
        signalGroup: () => {},
        healthToken: () => `launch-token-${n++}-padding`,
        restartDelayMs: 500,
      }),
    );
    await vi.advanceTimersByTimeAsync(1);
    const handle = start.value!;
    expect(handle.status()).toBe("running");
    expect(handle.ownsHealthAnswer({ ok: true, healthToken: tokens[0] })).toBe(true);
    expect(handle.ownsHealthAnswer({ ok: true })).toBe(false);
    expect(handle.ownsHealthAnswer({ ok: true, healthToken: "someone-elses-token" })).toBe(false);
    expect(handle.ownsHealthAnswer(null)).toBe(false);
    expect(handle.ownsHealthAnswer("launch-token-0-padding")).toBe(false);

    // The child crashes. The state stays running through the backoff, and
    // nothing answering on the port then is ours, even with the dead child's token.
    children[0].exitCode = 1;
    children[0].emit("exit", 1, null);
    expect(handle.status()).toBe("running");
    expect(handle.ownsHealthAnswer({ ok: true, healthToken: tokens[0] })).toBe(false);

    // The relaunch is spawned and health-checking: only its own token counts.
    await vi.advanceTimersByTimeAsync(600);
    expect(i).toBe(2);
    expect(handle.ownsHealthAnswer({ ok: true, healthToken: tokens[0] })).toBe(false);
    expect(handle.ownsHealthAnswer({ ok: true, healthToken: tokens[1] })).toBe(true);
    relaunchAnswers = true;
    await vi.advanceTimersByTimeAsync(200);
    expect(handle.ownsHealthAnswer({ ok: true, healthToken: tokens[1] })).toBe(true);
    await handle.stop();
    expect(handle.ownsHealthAnswer({ ok: true, healthToken: tokens[1] })).toBe(false);
  });

  it("a first launch that heard only another process on its port gives up on a fresh port, so its URLs never name that process", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const warn = vi.spyOn(serverLogger, "warn");
    const picks = [3999, 4100];
    const pickPort = vi.fn(async () => picks.shift()!);
    const onGaveUp = vi.fn();
    const start = settle(
      startMcpHttpChild({
        spawn: (() => child) as never,
        // Another instance's aggregator answers; our child never does.
        fetch: (async () => new Response(JSON.stringify({ ok: true, version: "other" }), { status: 200 })) as never,
        portFile: tmpPortFile(),
        entry: plainEntry,
        pickPort,
        isFree: async () => true,
        onGaveUp,
        healthTimeoutMs: 500,
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const handle = start.value!;
    expect(handle.status()).toBe("gave-up");
    expect(pickPort).toHaveBeenCalledTimes(2);
    expect(handle.publishedPort).toBeNull();
    expect(handle.advertisedPort).toBe(4100);
    // The failure still names the port the launch was on.
    expect((onGaveUp.mock.calls[0][0] as Error).message).toContain("port 3999");
    expect(warn.mock.calls.some(([o]) => (o as { op?: string; reason?: string }).reason === "foreign-answer")).toBe(true);
  });

  it("a first launch that heard nothing at all keeps its port: nothing says another process holds it", async () => {
    const child = fakeChild();
    const pickPort = vi.fn(async () => 3999);
    const handle = await startMcpHttpChild({
      spawn: (() => child) as never,
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as never,
      portFile: tmpPortFile(),
      entry: plainEntry,
      pickPort,
      isFree: async () => true,
      healthTimeoutMs: 50,
    });
    expect(handle.status()).toBe("gave-up");
    expect(pickPort).toHaveBeenCalledTimes(1);
    expect(handle.advertisedPort).toBe(3999);
  });
});

describe("a child ended by a closed Windows console", () => {
  // Closing a console window sends the close to its processes one at a time,
  // newest first, so the child is gone before the server hears the same close
  // and starts its own shutdown. Windows reports that child's exit as
  // STATUS_CONTROL_C_EXIT; Node hands the code over unsigned, and the signed
  // form is accepted too.
  const STATUS_CONTROL_C_EXIT_UNSIGNED = 3221225786;
  const STATUS_CONTROL_C_EXIT_SIGNED = -1073741510;
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  // Pinned inside each test: CI runs on Linux and a developer on macOS, and
  // the supervisor decides this by the host it believes it runs on.
  const pinPlatform = (platform: NodeJS.Platform) =>
    Object.defineProperty(process, "platform", { ...realPlatform, value: platform });

  afterEach(() => {
    Object.defineProperty(process, "platform", realPlatform);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function supervise(children: ReturnType<typeof fakeChild>[], maxRestarts = 3) {
    let i = 0;
    const spawn = vi.fn(() => children[i++]);
    const onGaveUp = vi.fn();
    const portFile = tmpPortFile();
    const handle = await startMcpHttpChild({
      spawn: spawn as never,
      fetch: (async () => new Response(HEALTHY_BODY, { status: 200 })) as never,
      portFile,
      entry: plainEntry,
      pickPort: async () => 3999,
      isFree: async () => true,
      restartDelayMs: 1,
      maxRestarts,
      onGaveUp,
    });
    return { handle, spawn, portFile, onGaveUp };
  }

  const closeConsole = (c: ReturnType<typeof fakeChild>, code: number) => {
    c.exitCode = code;
    c.emit("exit", code, null);
  };

  const ops = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map(([o]) => (o as { op?: string }).op);

  it.each([
    ["unsigned", STATUS_CONTROL_C_EXIT_UNSIGNED],
    ["signed", STATUS_CONTROL_C_EXIT_SIGNED],
  ])(
    "on win32 the exit (%s code) is logged at info, not as a crash, and the server's shutdown inside the wait cancels the relaunch",
    async (_label, code) => {
      pinPlatform("win32");
      vi.useFakeTimers();
      const info = vi.spyOn(serverLogger, "info");
      const warn = vi.spyOn(serverLogger, "warn");
      const children = [fakeChild(), fakeChild()];
      const env = await supervise(children);

      closeConsole(children[0], code);
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ tag: "mcp-http", op: "child_console_closed", code, restarts: 0 }),
      );
      expect(ops(warn)).not.toContain("child_exit");

      // The crash backoff here is 1 ms; this relaunch waits out Windows' close instead.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(env.spawn).toHaveBeenCalledTimes(1);

      await env.handle.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(env.spawn).toHaveBeenCalledTimes(1);
      expect(env.handle.status()).toBe("stopped");
      expect(env.onGaveUp).not.toHaveBeenCalled();
      expect(ops(warn)).not.toContain("child_exit");
    },
  );

  it("on win32, with no shutdown after the wait, the child is relaunched and the relaunch spends the restart budget like a crash", async () => {
    pinPlatform("win32");
    vi.useFakeTimers();
    const children = [fakeChild(), fakeChild(), fakeChild()];
    const env = await supervise(children, 1);
    expect(fs.readFileSync(env.portFile, "utf-8")).toBe("3999");

    closeConsole(children[0], STATUS_CONTROL_C_EXIT_UNSIGNED);
    await vi.advanceTimersByTimeAsync(5_900);
    expect(env.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(env.spawn).toHaveBeenCalledTimes(2);
    expect(env.handle.status()).toBe("running");
    expect(fs.readFileSync(env.portFile, "utf-8")).toBe("3999");

    // The budget of one is spent: the next crash gives up instead of relaunching.
    children[1].exitCode = 1;
    children[1].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(100);
    expect(env.handle.status()).toBe("gave-up");
    expect(env.onGaveUp).toHaveBeenCalledTimes(1);
    expect(env.spawn).toHaveBeenCalledTimes(2);
  });

  it("on win32 with the restart budget already spent, a shutdown inside the wait ends the supervisor stopped, not gave-up", async () => {
    pinPlatform("win32");
    vi.useFakeTimers();
    const error = vi.spyOn(serverLogger, "error");
    const children = [fakeChild()];
    const env = await supervise(children, 0);

    closeConsole(children[0], STATUS_CONTROL_C_EXIT_UNSIGNED);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(env.handle.status()).toBe("running");
    expect(env.onGaveUp).not.toHaveBeenCalled();

    await env.handle.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(env.handle.status()).toBe("stopped");
    expect(env.onGaveUp).not.toHaveBeenCalled();
    expect(ops(error)).not.toContain("child_gave_up");
  });

  it.each([
    ["darwin", STATUS_CONTROL_C_EXIT_UNSIGNED],
    ["linux", STATUS_CONTROL_C_EXIT_UNSIGNED],
    ["win32", 1],
  ] as const)("on %s an exit with code %s is still a crash: warned, and relaunched after the usual backoff", async (platform, code) => {
    pinPlatform(platform);
    vi.useFakeTimers();
    const info = vi.spyOn(serverLogger, "info");
    const warn = vi.spyOn(serverLogger, "warn");
    const children = [fakeChild(), fakeChild()];
    const env = await supervise(children);

    closeConsole(children[0], code);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ tag: "mcp-http", op: "child_exit", code, restarts: 0 }));
    expect(ops(info)).not.toContain("child_console_closed");
    await vi.advanceTimersByTimeAsync(20);
    expect(env.spawn).toHaveBeenCalledTimes(2);
    expect(env.handle.status()).toBe("running");
    await env.handle.stop();
  });
});
