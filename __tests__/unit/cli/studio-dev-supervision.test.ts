import { describe, it, expect, vi, afterEach, type Mock } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `next dev` in a dev checkout runs as a child of the libi CLI, and its server
 * is where the orderly shutdown lives (agent processes retired, the MCP
 * endpoint stopped, port files dropped). The CLI has to outlive that shutdown
 * instead of exiting on the Ctrl-C: on Windows its exit ends the whole tree
 * through the job object Node puts its children in, and on POSIX the prompt
 * came back mid-shutdown with a failure code.
 *
 * The timing is driven through the exported `superviseDevServer` with fake
 * timers, a fake process and a fake `next dev`. The tree kill runs against
 * real processes on POSIX.
 */

vi.mock("@/lib/server/lifecycle", () => ({ runInstallPhase: vi.fn() }));
vi.mock("@/lib/server/lifecycle/adapters/cli", () => ({ cliAdapter: vi.fn(() => ({})) }));

import {
  devExitCodeFor,
  killDevProcessTree,
  readProcessTable,
  superviseDevServer,
  type ProcessRow,
} from "@/lib/cli/studio";

type FakeNextDev = EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: Mock;
};

/** Pids a real-process case started; a failed case must not leave them running. */
const started: number[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The CLI's supervision of a fake `next dev`, on `platform`, under fake timers. */
function supervise(platform: NodeJS.Platform) {
  vi.useFakeTimers();
  const child = new EventEmitter() as FakeNextDev;
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => true);
  const proc = new EventEmitter();
  const exit = vi.fn();
  // Never the real walk here: the fake pid is made up, and a real process could own it.
  const killTree = vi.fn();
  const stdout = { write: vi.fn() };
  const stderr = { write: vi.fn() };
  superviseDevServer(child as unknown as ChildProcess, {
    proc,
    platform,
    exit,
    killTree,
    stdout,
    stderr,
  });
  const nextDevExits = (code: number | null, signal: NodeJS.Signals | null = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
  };
  return { child, proc, exit, killTree, stdout, stderr, nextDevExits };
}

describe("superviseDevServer", () => {
  it("a Ctrl-C does not end the CLI: it exits with next dev's own code once next dev has finished", async () => {
    const { child, proc, exit, killTree, nextDevExits } = supervise("darwin");
    proc.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(800);
    expect(exit).not.toHaveBeenCalled();
    // From a terminal, next dev got the Ctrl-C itself and is done before a second has passed.
    nextDevExits(0);
    expect(exit).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(killTree).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("a SIGINT sent to the CLI alone reaches next dev a second later", async () => {
    const { child, proc } = supervise("linux");
    proc.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
  });

  it("a SIGINT a second after the first is the launcher passing the same Ctrl-C on, and kills nothing", async () => {
    const { child, proc, exit, killTree } = supervise("darwin");
    proc.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(1_050);
    proc.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(killTree).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    // Passed on once, by its own delayed forward, never again for the repeat.
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  // A SIGHUP goes on as SIGTERM: next dev runs under npx, and npx passes only
  // SIGINT and SIGTERM on, so a SIGHUP would end npx and strand next dev.
  it.each([
    ["SIGTERM", "SIGTERM"],
    ["SIGHUP", "SIGTERM"],
  ] as const)("%s reaches next dev at once on POSIX, as %s", (signal, forwarded) => {
    const { child, proc } = supervise("darwin");
    proc.emit(signal);
    expect(child.kill).toHaveBeenCalledWith(forwarded);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("15 s after the first signal, next dev's whole tree is killed and the CLI exits 130; the late exit changes nothing", async () => {
    const { proc, exit, killTree, nextDevExits } = supervise("darwin");
    proc.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(killTree).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(killTree).toHaveBeenCalledWith(4242);
    expect(exit).toHaveBeenCalledWith(130);
    nextDevExits(null, "SIGKILL");
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("on Windows nothing is passed on, and the deadline exits 130 without walking a tree: the job object ends it", async () => {
    const { child, proc, exit, killTree } = supervise("win32");
    proc.emit("SIGINT");
    proc.emit("SIGHUP");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(13_000);
    expect(killTree).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("passes next dev's own exit code through, the relaunch request's 75 with its message", () => {
    const relaunch = supervise("darwin");
    relaunch.nextDevExits(75);
    expect(relaunch.exit).toHaveBeenCalledWith(75);
    expect(relaunch.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining("Server requested restart"),
    );

    const failed = supervise("darwin");
    failed.nextDevExits(1);
    expect(failed.exit).toHaveBeenCalledWith(1);
  });

  it("a next dev killed by a signal nobody asked the CLI for exits 128 plus the signal number, not 0", () => {
    const oomKilled = supervise("darwin");
    oomKilled.nextDevExits(null, "SIGKILL");
    expect(oomKilled.exit).toHaveBeenCalledWith(128 + os.constants.signals.SIGKILL);

    const crashed = supervise("linux");
    crashed.nextDevExits(null, "SIGSEGV");
    expect(crashed.exit).toHaveBeenCalledWith(128 + os.constants.signals.SIGSEGV);
  });

  it("a next dev that dies by a signal after the CLI was asked to shut down exits 0, and its own code still wins", () => {
    const shutdown = supervise("darwin");
    shutdown.proc.emit("SIGTERM");
    shutdown.nextDevExits(null, "SIGTERM");
    expect(shutdown.exit).toHaveBeenCalledWith(0);

    const coded = supervise("darwin");
    coded.proc.emit("SIGINT");
    coded.nextDevExits(130);
    expect(coded.exit).toHaveBeenCalledWith(130);

    expect(devExitCodeFor(null, null, false)).toBe(1);
    expect(devExitCodeFor(null, "SIGTERM", true)).toBe(0);
    expect(devExitCodeFor(null, "SIGTERM", false)).toBe(128 + os.constants.signals.SIGTERM);
  });

  it("a next dev that cannot be started says why and exits 1", () => {
    const { child, exit, stderr } = supervise("win32");
    child.emit("error", Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" }));
    expect(stderr.write).toHaveBeenCalledWith("[libi] could not start next dev: spawn npx ENOENT\n");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("killDevProcessTree", () => {
  it("does not kill a pid handed to another process between the walk and the kill, and resumes that process", () => {
    const started = "lstart:Fri Sep 11 18:00:00 2026";
    const found: ProcessRow[] = [
      [700, 600, started],
      [701, 700, started],
      [702, 700, started],
    ];
    // 702 exited after the read that listed it, and its pid now names a newer, unrelated process.
    const after: ProcessRow[] = [
      [700, 600, started],
      [701, 700, started],
      [702, 800, "lstart:Fri Sep 11 18:00:05 2026"],
    ];
    let reads = 0;
    const calls: Array<[number, NodeJS.Signals]> = [];
    const killed = killDevProcessTree(700, {
      processTable: () => (reads++ === 0 ? found : after),
      kill: (pid, signal) => void calls.push([pid, signal]),
      self: 600,
    });
    expect([...killed].sort()).toEqual([700, 701]);
    expect(calls.filter(([pid]) => pid === 702)).toEqual([
      [702, "SIGSTOP"],
      [702, "SIGCONT"],
    ]);
  });

  it("still kills every process when a step of the wall clock moves every start time, since none of them left the tree", () => {
    const started = "lstart:Fri Sep 11 18:00:00 2026";
    const found: ProcessRow[] = [
      [700, 600, started],
      [701, 700, started],
      [702, 700, started],
    ];
    // Linux ps derives start times from the boot time, which a clock step moves for every process at once.
    const stepped = found.map(([pid, ppid]): ProcessRow => [pid, ppid, "lstart:Fri Sep 11 18:00:01 2026"]);
    let reads = 0;
    const calls: Array<[number, NodeJS.Signals]> = [];
    const killed = killDevProcessTree(700, {
      processTable: () => (reads++ === 0 ? found : stepped),
      kill: (pid, signal) => void calls.push([pid, signal]),
      self: 600,
    });
    expect([...killed].sort()).toEqual([700, 701, 702]);
    expect(calls.some(([, signal]) => signal === "SIGCONT")).toBe(false);
  });

  it("kills a process that took a recycled pid inside the tree, since it is still below the root", () => {
    const started = "lstart:Fri Sep 11 18:00:00 2026";
    const found: ProcessRow[] = [
      [700, 600, started],
      [701, 700, started],
      [702, 700, started],
    ];
    // 702 exited before its SIGSTOP, and 701 started a new child that was handed the same pid.
    const after: ProcessRow[] = [
      [700, 600, started],
      [701, 700, started],
      [702, 701, "lstart:Fri Sep 11 18:00:05 2026"],
    ];
    let reads = 0;
    const calls: Array<[number, NodeJS.Signals]> = [];
    const killed = killDevProcessTree(700, {
      processTable: () => (reads++ === 0 ? found : after),
      kill: (pid, signal) => void calls.push([pid, signal]),
      self: 600,
    });
    expect([...killed].sort()).toEqual([700, 701, 702]);
    expect(calls.filter(([pid]) => pid === 702)).toEqual([
      [702, "SIGSTOP"],
      [702, "SIGKILL"],
    ]);
  });

  it("stops every process in the tree before killing any, and signals nothing outside it", () => {
    const table: Array<[number, number]> = [
      [1, 0],
      [600, 1], // this CLI
      [700, 600], // next dev
      [701, 700],
      [702, 700],
      [703, 701],
      [800, 1], // unrelated
      [900, 600], // another child of this CLI
    ];
    const calls: Array<[number, NodeJS.Signals]> = [];
    const killed = killDevProcessTree(700, {
      processTable: () => table,
      kill: (pid, signal) => void calls.push([pid, signal]),
      self: 600,
    });

    expect([...killed].sort()).toEqual([700, 701, 702, 703]);
    // Positive pids only: never a process group.
    expect(calls.every(([pid]) => pid > 1)).toBe(true);
    const firstKill = calls.findIndex(([, signal]) => signal === "SIGKILL");
    expect(calls.slice(0, firstKill).every(([, signal]) => signal === "SIGSTOP")).toBe(true);
    expect(calls.slice(firstKill)).toEqual(killed.map((pid) => [pid, "SIGKILL"]));
  });

  it("walks again after stopping, so a process started during the walk is killed too", () => {
    const tables: Array<Array<[number, number]>> = [
      [[700, 600], [701, 700]],
      [[700, 600], [701, 700], [704, 701]],
    ];
    let reads = 0;
    const killed = killDevProcessTree(700, {
      processTable: () => tables[Math.min(reads++, tables.length - 1)],
      kill: () => {},
      self: 600,
    });
    expect([...killed].sort()).toEqual([700, 701, 704]);
  });

  it("never signals itself or pid 1, and kills the root alone when there is no process table", () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    const kill = (pid: number, signal: NodeJS.Signals) => void calls.push([pid, signal]);
    // A table where this process shows up below the root can only be pid reuse.
    killDevProcessTree(700, { processTable: () => [[700, 600], [600, 700]], kill, self: 600 });
    expect(calls.some(([pid]) => pid === 600)).toBe(false);

    expect(killDevProcessTree(1, { processTable: () => [], kill, self: 600 })).toEqual([]);

    calls.length = 0;
    expect(killDevProcessTree(700, { processTable: () => null, kill, self: 600 })).toEqual([700]);
    expect(calls).toEqual([
      [700, "SIGSTOP"],
      [700, "SIGKILL"],
    ]);
  });
});

describe("readProcessTable", () => {
  it("reads /proc first wherever /proc/self/stat can be read, and ps where /proc cannot be listed", () => {
    const stat = (pid: number, ppid: number, start: number) =>
      `${pid} (node) S ${ppid} ${pid} ${pid} 0 -1 4194560 100 200 0 0 5 6 0 0 20 0 1 0 ${start} 1000 10\n`;
    const stats: Record<string, string> = {
      "/proc/self/stat": stat(5, 1, 9),
      "/proc/1/stat": stat(1, 0, 7),
      "/proc/5/stat": stat(5, 1, 9),
    };
    const readFileSync = (p: string) => {
      if (!(p in stats)) throw new Error("ENOENT");
      return stats[p];
    };
    const run = vi.fn(() => "    1     0 Wed Aug 26 01:47:01 2026\n");
    expect(readProcessTable(run, { readdirSync: () => ["1", "self", "5"], readFileSync })).toEqual([
      [1, 0, "starttime:7"],
      [5, 1, "starttime:9"],
    ]);
    expect(run).not.toHaveBeenCalled();
    const unlisted = () => {
      throw new Error("EACCES");
    };
    expect(readProcessTable(run, { readdirSync: unlisted, readFileSync })).toEqual([
      [1, 0, "lstart:Wed Aug 26 01:47:01 2026"],
    ]);
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

describe.skipIf(process.platform === "win32")("killDevProcessTree on real processes", () => {
  it("kills a process and a grandchild below it that ignores SIGTERM, and leaves a bystander alone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-dev-tree-"));
    tmpDirs.push(dir);
    const stubborn = path.join(dir, "stubborn.js");
    fs.writeFileSync(
      stubborn,
      `process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); setInterval(() => {}, 1000);`,
    );
    const parentScript = path.join(dir, "parent.js");
    fs.writeFileSync(
      parentScript,
      [
        `const { spawn } = require("child_process");`,
        `const g = spawn(process.execPath, [${JSON.stringify(stubborn)}], { stdio: "ignore" });`,
        `process.stdout.write(g.pid + "\\n");`,
        `setInterval(() => {}, 1000);`,
      ].join("\n"),
    );

    const bystander = spawn(process.execPath, [stubborn], { stdio: "ignore" });
    started.push(bystander.pid as number);
    const parent = spawn(process.execPath, [parentScript], { stdio: ["ignore", "pipe", "ignore"] });
    started.push(parent.pid as number);
    const grandchild = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the grandchild never started")), 5_000);
      let out = "";
      parent.stdout?.on("data", (d: Buffer) => {
        out += d.toString();
        if (out.includes("\n")) {
          clearTimeout(timer);
          resolve(Number(out.trim()));
        }
      });
    });
    started.push(grandchild);
    const parentExited = new Promise<NodeJS.Signals | null>((resolve) =>
      parent.on("exit", (_code, signal) => resolve(signal)),
    );

    const killed = killDevProcessTree(parent.pid as number);

    expect(killed).toEqual(expect.arrayContaining([parent.pid, grandchild]));
    expect(killed).not.toContain(bystander.pid);
    expect(killed).not.toContain(process.pid);
    expect(await parentExited).toBe("SIGKILL");
    await waitFor(() => !isAlive(grandchild), "the grandchild to be gone");
    expect(isAlive(bystander.pid as number)).toBe(true);
  }, 20_000);
});
