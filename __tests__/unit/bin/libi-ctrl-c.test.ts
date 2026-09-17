import { describe, expect, it, afterEach, vi, type Mock } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `bin/libi.js` stands between a terminal and the libi server it launches.
 *
 * A terminal's Ctrl-C reaches both at the same moment. The server shuts down
 * in its own SIGINT handler (agent processes retired, the MCP endpoint
 * stopped, port files dropped) and then exits, and the wrapper has to wait for
 * that instead of exiting on the signal: on Windows a Node process's children
 * are killed with it, so a wrapper that exits on Ctrl-C ends the server before
 * any of its shutdown runs. Waiting must not become a trap, though: a second
 * Ctrl-C, or a shutdown that runs out its deadline, still ends everything, and
 * a signal aimed at the wrapper alone still reaches the server.
 *
 * The real-process cases run on POSIX, where a process group stands in for the
 * terminal. The installed layout is copied into a temp dir so the wrapper
 * takes its compiled-entry branch and runs a fake server. The deadline and the
 * Windows branch are driven through the exported `superviseServer` with fake
 * timers, a fake process and a fake server.
 */
const BIN_PATH = path.resolve(__dirname, "..", "..", "..", "bin", "libi.js");

type Exit = { code: number | null; signal: NodeJS.Signals | null; at: number };
type Mark = { at: number; text: string };

const tmpDirs: string[] = [];
/** Process groups the real-process cases started; a failed case must not leave a wrapper or fake server running. */
const groups: number[] = [];
afterEach(() => {
  for (const pgid of groups.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
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

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

function readMarks(marker: string): Mark[] {
  if (!fs.existsSync(marker)) return [];
  return fs
    .readFileSync(marker, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(" ");
      return { at: Number(line.slice(0, space)), text: line.slice(space + 1) };
    });
}

/**
 * Launch the wrapper from an installed layout whose server runs `serverLines`.
 * The server can call `mark(text)` to record what happened, with a timestamp.
 * Resolves once the server is up.
 */
async function launch(serverLines: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-bin-signals-"));
  tmpDirs.push(root);
  const pkg = path.join(root, "node_modules", "@nagellabs", "libi");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.mkdirSync(path.join(pkg, "dist-cli", "lib", "cli"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), "{}");
  fs.copyFileSync(BIN_PATH, path.join(pkg, "bin", "libi.js"));
  const marker = path.join(root, "server-marks");
  fs.writeFileSync(
    path.join(pkg, "dist-cli", "lib", "cli", "index.js"),
    [
      `const fs = require("fs");`,
      `const mark = (text) => fs.appendFileSync(${JSON.stringify(marker)}, Date.now() + " " + text + "\\n");`,
      ...serverLines,
      `mark("pid " + process.pid);`,
      `process.stdout.write("ready\\n");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"),
  );

  // Its own group, so a test can signal it the way a terminal signals its foreground job.
  const wrapper: ChildProcess = spawn(process.execPath, [path.join(pkg, "bin", "libi.js")], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  groups.push(wrapper.pid as number);
  let exit: Exit | null = null;
  const exited = new Promise<Exit>((resolve) =>
    wrapper.on("exit", (code, signal) => {
      exit = { code, signal, at: Date.now() };
      resolve(exit);
    }),
  );
  await new Promise<void>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("the fake server never started")), 10_000);
    wrapper.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.includes("ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const pidMark = readMarks(marker).find((m) => m.text.startsWith("pid "));
  return {
    pid: wrapper.pid as number,
    serverPid: Number(pidMark?.text.slice(4)),
    exited,
    hasExited: () => exit !== null,
    marks: () => readMarks(marker),
  };
}

describe.skipIf(process.platform === "win32")("bin/libi.js and the signals that end libi", () => {
  it("a terminal's Ctrl-C: the server shuts down on the signal it got, and the wrapper exits 0 after it without sending it again", async () => {
    const s = await launch([
      `process.on("SIGINT", () => { mark("SIGINT"); setTimeout(() => { mark("exit"); process.exit(0); }, 400); });`,
    ]);

    // What a terminal does on Ctrl-C: the signal goes to the whole foreground group.
    process.kill(-s.pid, "SIGINT");
    const { code, signal, at } = await s.exited;

    expect(signal).toBeNull();
    expect(code).toBe(0);
    const marks = s.marks();
    expect(marks.filter((m) => m.text === "SIGINT")).toHaveLength(1);
    const exitMark = marks.find((m) => m.text === "exit");
    expect(exitMark).toBeDefined();
    expect(exitMark!.at).toBeLessThanOrEqual(at);
  }, 20_000);

  it("a shutdown that never finishes: a second Ctrl-C a second later kills the server and exits 130", async () => {
    const s = await launch([`process.on("SIGINT", () => mark("SIGINT"));`]);

    const sentAt = Date.now();
    process.kill(-s.pid, "SIGINT");
    await sleep(1_000);
    expect(s.hasExited()).toBe(false);
    process.kill(-s.pid, "SIGINT");
    const { code, signal, at } = await s.exited;

    expect(signal).toBeNull();
    expect(code).toBe(130);
    expect(at - sentAt).toBeLessThan(2_500);
    await waitFor(() => !isAlive(s.serverPid), "the wedged server to be gone");
  }, 20_000);

  it("a SIGINT sent to the wrapper alone reaches the server a second later, and both exit", async () => {
    const s = await launch([
      `process.on("SIGINT", () => { mark("SIGINT"); setTimeout(() => process.exit(0), 100); });`,
    ]);

    const sentAt = Date.now();
    process.kill(s.pid, "SIGINT");
    const { code, signal, at } = await s.exited;

    expect(signal).toBeNull();
    expect(code).toBe(0);
    const got = s.marks().filter((m) => m.text === "SIGINT");
    expect(got).toHaveLength(1);
    expect(got[0].at - sentAt).toBeGreaterThanOrEqual(900);
    expect(at - sentAt).toBeLessThan(3_000);
    await waitFor(() => !isAlive(s.serverPid), "the server to be gone");
  }, 20_000);

  it("a SIGTERM sent to the wrapper alone reaches the server at once, and the wrapper exits after it", async () => {
    const s = await launch([
      `process.on("SIGTERM", () => { mark("SIGTERM"); setTimeout(() => { mark("exit"); process.exit(0); }, 200); });`,
    ]);

    const sentAt = Date.now();
    process.kill(s.pid, "SIGTERM");
    const { code, signal, at } = await s.exited;

    expect(signal).toBeNull();
    expect(code).toBe(0);
    const got = s.marks().find((m) => m.text === "SIGTERM");
    expect(got).toBeDefined();
    expect(got!.at - sentAt).toBeLessThan(500);
    expect(s.marks().find((m) => m.text === "exit")!.at).toBeLessThanOrEqual(at);
  }, 20_000);

  it("a SIGHUP sent to the wrapper alone reaches the server at once as SIGTERM, and the wrapper exits after it", async () => {
    const s = await launch([
      `process.on("SIGHUP", () => mark("SIGHUP"));`,
      `process.on("SIGTERM", () => { mark("SIGTERM"); setTimeout(() => { mark("exit"); process.exit(0); }, 200); });`,
    ]);

    const sentAt = Date.now();
    process.kill(s.pid, "SIGHUP");
    const { code, signal, at } = await s.exited;

    expect(signal).toBeNull();
    expect(code).toBe(0);
    expect(s.marks().some((m) => m.text === "SIGHUP")).toBe(false);
    const got = s.marks().find((m) => m.text === "SIGTERM");
    expect(got).toBeDefined();
    expect(got!.at - sentAt).toBeLessThan(500);
    expect(s.marks().find((m) => m.text === "exit")!.at).toBeLessThanOrEqual(at);
  }, 20_000);

  it("a server that exits on its own passes its code through, the relaunch request's 75 included", async () => {
    const s = await launch([`setTimeout(() => process.exit(75), 300);`]);
    const { code, signal } = await s.exited;
    expect(signal).toBeNull();
    expect(code).toBe(75);
  }, 20_000);

  it("a server killed by a signal exits the wrapper with 128 plus the signal number, not 0", async () => {
    const s = await launch([`setTimeout(() => process.kill(process.pid, "SIGKILL"), 300);`]);
    const { code, signal } = await s.exited;
    expect(signal).toBeNull();
    expect(code).toBe(128 + os.constants.signals.SIGKILL);
  }, 20_000);

  it("a forced end kills the server's whole tree: a process under it that ignores SIGTERM does not outlive the wrapper", async () => {
    // Under `npm run dev` the wrapper's child is tsx, and the process whose
    // shutdown wedged sits below it. Here the server stands in for tsx and its
    // own child for that process.
    const s = await launch([
      `const { spawn } = require("child_process");`,
      `const below = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });`,
      `mark("below " + below.pid);`,
      `process.on("SIGTERM", () => mark("SIGTERM"));`,
    ]);
    const below = Number(s.marks().find((m) => m.text.startsWith("below "))!.text.slice(6));
    expect(isAlive(below)).toBe(true);

    // Aimed at the wrapper alone, so nothing but the wrapper's own kill can reach the process below.
    process.kill(s.pid, "SIGTERM");
    await sleep(1_000);
    expect(s.hasExited()).toBe(false);
    process.kill(s.pid, "SIGINT");
    const { code, signal } = await s.exited;

    expect(signal).toBeNull();
    expect(code).toBe(130);
    await waitFor(() => !isAlive(s.serverPid), "the server to be gone");
    await waitFor(() => !isAlive(below), "the process below the server to be gone");
  }, 20_000);
});

/**
 * Launch the wrapper from a source layout, so it starts the server the way
 * `npm run dev` does: through a real tsx wrapper (this repo's tsx, linked in),
 * running a TypeScript fake server. The server's parent is tsx, and a signal
 * tsx does not relay never reaches it. Resolves once the server is up.
 */
async function launchThroughTsx(serverLines: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-bin-tsx-"));
  tmpDirs.push(root);
  // A package root without `.git` and outside node_modules: the wrapper runs
  // lib/cli/index.ts through tsx and skips the dev-checkout bootstrap.
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}");
  fs.mkdirSync(path.join(root, "bin"));
  fs.copyFileSync(BIN_PATH, path.join(root, "bin", "libi.js"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(TSX_PACKAGE, path.join(root, "node_modules", "tsx"), "dir");
  fs.mkdirSync(path.join(root, "lib", "cli"), { recursive: true });
  const marker = path.join(root, "server-marks");
  fs.writeFileSync(
    path.join(root, "lib", "cli", "index.ts"),
    [
      `const fs = require("fs");`,
      `const mark = (text: string) => fs.appendFileSync(${JSON.stringify(marker)}, Date.now() + " " + text + "\\n");`,
      ...serverLines,
      `mark("pid " + process.pid);`,
      `mark("parent " + process.ppid);`,
      `process.stdout.write("ready\\n");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"),
  );

  const wrapper: ChildProcess = spawn(process.execPath, [path.join(root, "bin", "libi.js")], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  groups.push(wrapper.pid as number);
  let exit: Exit | null = null;
  const exited = new Promise<Exit>((resolve) =>
    wrapper.on("exit", (code, signal) => {
      exit = { code, signal, at: Date.now() };
      resolve(exit);
    }),
  );
  await new Promise<void>((resolve, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(() => reject(new Error(`the fake server never started: ${err}`)), 15_000);
    wrapper.stderr?.on("data", (d: Buffer) => void (err += d.toString()));
    wrapper.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.includes("ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const numberAfter = (prefix: string) =>
    Number(readMarks(marker).find((m) => m.text.startsWith(prefix))?.text.slice(prefix.length));
  return {
    pid: wrapper.pid as number,
    serverPid: numberAfter("pid "),
    tsxPid: numberAfter("parent "),
    numberAfter,
    exited,
    marks: () => readMarks(marker),
  };
}

const TSX_PACKAGE = path.resolve(__dirname, "..", "..", "..", "node_modules", "tsx");

/** A fake server that shuts down once on SIGTERM, SIGINT or SIGHUP, ending a process of its own first. */
const SHUTDOWN_ONCE = [
  `const { spawn } = require("child_process");`,
  `const below = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
  `mark("below " + below.pid);`,
  `let stopping = false;`,
  `for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => {`,
  `  mark(s);`,
  `  if (stopping) return;`,
  `  stopping = true;`,
  `  setTimeout(() => { below.kill("SIGTERM"); mark("exit"); process.exit(0); }, 300);`,
  `});`,
];

describe.skipIf(process.platform === "win32")("bin/libi.js through a real tsx wrapper", () => {
  it("a SIGHUP sent to the wrapper alone reaches the server below tsx, whose shutdown runs, and every process exits", async () => {
    const s = await launchThroughTsx(SHUTDOWN_ONCE);
    const below = s.numberAfter("below ");
    expect(s.tsxPid).not.toBe(s.pid);
    expect([s.tsxPid, s.serverPid, below].every(isAlive)).toBe(true);

    // What a process manager passing a hangup to its direct child does.
    process.kill(s.pid, "SIGHUP");
    const { code, signal, at } = await s.exited;

    // A SIGHUP passed on as such ended tsx at once, and the wrapper exited 129 with it.
    expect(signal).toBeNull();
    expect(code).toBe(0);
    const marks = s.marks();
    expect(marks.filter((m) => m.text === "SIGTERM")).toHaveLength(1);
    const exitMark = marks.find((m) => m.text === "exit");
    expect(exitMark).toBeDefined();
    expect(exitMark!.at).toBeLessThanOrEqual(at);
    for (const [pid, what] of [
      [s.tsxPid, "tsx"],
      [s.serverPid, "the server"],
      [below, "the server's own process"],
    ] as const) {
      await waitFor(() => !isAlive(pid), `${what} to be gone`);
    }
  }, 30_000);

  it("a closed terminal (SIGHUP to the whole group) still runs the server's shutdown, and every process exits", async () => {
    const s = await launchThroughTsx(SHUTDOWN_ONCE);
    const below = s.numberAfter("below ");

    process.kill(-s.pid, "SIGHUP");
    await s.exited;

    await waitFor(() => s.marks().some((m) => m.text === "exit"), "the server's shutdown to finish");
    for (const [pid, what] of [
      [s.tsxPid, "tsx"],
      [s.serverPid, "the server"],
      [below, "the server's own process"],
    ] as const) {
      await waitFor(() => !isAlive(pid), `${what} to be gone`);
    }
  }, 30_000);
});

type FakeServer = EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: Mock;
};

/** pid, parent pid, and the start time the table read for it. */
type ProcessRow = [number, number, string?];
type ProcessTable = ProcessRow[] | null;

const bin = createRequire(BIN_PATH)(BIN_PATH) as {
  superviseServer: (child: unknown, opts: Record<string, unknown>) => void;
  exitCodeFor: (code: number | null, signal: NodeJS.Signals | null) => number;
  forwardedSignal: (signal: NodeJS.Signals) => NodeJS.Signals;
  taskkillPath: (systemRoot: string) => string;
  killProcessTree: (
    rootPid: number,
    opts?: {
      processTable?: () => ProcessTable;
      kill?: (pid: number, signal: string) => void;
      self?: number;
    },
  ) => number[];
  descendantsOf: (rootPid: number, table: ProcessRow[]) => number[];
  processTable: (
    run?: (...args: unknown[]) => string,
    fsApi?: { readdirSync: (p: string) => string[]; readFileSync: (p: string, enc: string) => string },
  ) => ProcessTable;
};

/** The wrapper's supervision of a fake server, on `platform`, under fake timers. */
function supervise(platform: NodeJS.Platform) {
  vi.useFakeTimers();
  const child = new EventEmitter() as FakeServer;
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => true);
  const proc = new EventEmitter();
  const exit = vi.fn();
  const taskkill = new EventEmitter();
  const spawnTaskkill = vi.fn(() => taskkill);
  // Never the real walk here: the fake server's pid is made up, and a real process could own it.
  const killTree = vi.fn();
  bin.superviseServer(child, {
    proc,
    platform,
    exit,
    spawn: spawnTaskkill,
    killTree,
    systemRoot: "C:\\Windows",
  });
  const serverExits = (code: number | null, signal: NodeJS.Signals | null = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
  };
  return { child, proc, exit, taskkill, spawnTaskkill, killTree, serverExits };
}

describe("bin/libi.js superviseServer", () => {
  it("gives the server 15 s after the first signal, then kills its whole tree and exits 130", async () => {
    const { child, proc, exit, killTree } = supervise("darwin");
    proc.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(999);
    expect(child.kill).not.toHaveBeenCalled();
    // Still running a second later: the signal may have been aimed at the wrapper alone.
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
    await vi.advanceTimersByTimeAsync(13_999);
    expect(exit).not.toHaveBeenCalled();
    expect(killTree).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(killTree).toHaveBeenCalledWith(4242);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("a server that finishes in time decides the exit code, and nothing fires afterwards", async () => {
    const { child, proc, exit, serverExits } = supervise("linux");
    proc.emit("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    serverExits(0);
    expect(exit).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("a SIGINT within half a second of the first is npm relaying the same Ctrl-C and forces nothing; a later one does", async () => {
    const { child, proc, exit, killTree } = supervise("darwin");
    proc.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(100);
    proc.emit("SIGINT");
    expect(child.kill).not.toHaveBeenCalled();
    expect(killTree).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    proc.emit("SIGINT");
    expect(child.kill).not.toHaveBeenCalled();
    expect(killTree).toHaveBeenCalledWith(4242);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("on Windows nothing is passed on, and a second Ctrl-C ends the server's tree with taskkill before exiting 130", async () => {
    const { child, proc, exit, taskkill, spawnTaskkill, killTree, serverExits } = supervise("win32");
    proc.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(2_000);
    // The server got Ctrl-C from the console itself; kill() there would terminate it mid-shutdown.
    expect(child.kill).not.toHaveBeenCalled();
    expect(spawnTaskkill).not.toHaveBeenCalled();

    proc.emit("SIGINT");
    expect(bin.taskkillPath("C:\\Windows")).toBe("C:\\Windows\\System32\\taskkill.exe");
    expect(spawnTaskkill).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/T", "/F", "/PID", "4242"],
      expect.objectContaining({ windowsHide: true }),
    );
    // No POSIX process walk on Windows: taskkill /T is the tree kill there.
    expect(killTree).not.toHaveBeenCalled();
    // The server dies before taskkill reports; exiting now would cut taskkill off too.
    serverExits(1);
    expect(exit).not.toHaveBeenCalled();
    taskkill.emit("exit", 0);
    expect(exit).toHaveBeenCalledWith(130);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("on Windows a taskkill that fails falls back to killing the server directly", async () => {
    const { child, proc, exit, taskkill } = supervise("win32");
    proc.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(600);
    proc.emit("SIGINT");
    taskkill.emit("exit", 128);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("on Windows SIGTERM and SIGHUP are not passed on, and the server's own exit still decides the code", async () => {
    const { child, proc, exit, serverExits } = supervise("win32");
    proc.emit("SIGHUP");
    proc.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).not.toHaveBeenCalled();
    serverExits(0);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("on POSIX a SIGHUP reaches the server as SIGTERM, once", () => {
    const { child, proc } = supervise("linux");
    proc.emit("SIGHUP");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("passes a hangup on as SIGTERM and every other signal as itself", () => {
    expect(bin.forwardedSignal("SIGHUP")).toBe("SIGTERM");
    expect(bin.forwardedSignal("SIGTERM")).toBe("SIGTERM");
    expect(bin.forwardedSignal("SIGINT")).toBe("SIGINT");
  });

  it("maps a server's end to an exit code: its own code, or 128 plus the signal number", () => {
    expect(bin.exitCodeFor(0, null)).toBe(0);
    expect(bin.exitCodeFor(75, null)).toBe(75);
    expect(bin.exitCodeFor(null, "SIGKILL")).toBe(128 + os.constants.signals.SIGKILL);
    expect(bin.exitCodeFor(null, "SIGINT")).toBe(128 + os.constants.signals.SIGINT);
    expect(bin.exitCodeFor(null, null)).toBe(1);
  });
});

describe("bin/libi.js killProcessTree", () => {
  const table: Array<[number, number]> = [
    [1, 0],
    [500, 1], // npm, above the launcher
    [600, 500], // the launcher
    [700, 600], // the server it started
    [701, 700],
    [702, 700],
    [703, 701],
    [800, 1], // unrelated
    [900, 500], // the launcher's sibling in the same process group
  ];

  it("stops every process in the server's tree before killing any, and signals nothing outside it", () => {
    const calls: Array<[number, string]> = [];
    const killed = bin.killProcessTree(700, {
      processTable: () => table,
      kill: (pid, signal) => void calls.push([pid, signal]),
      self: 600,
    });

    expect([...killed].sort()).toEqual([700, 701, 702, 703]);
    // Positive pids only: never a process group, which is the terminal job's or npm's.
    expect(calls.every(([pid]) => pid > 1)).toBe(true);
    const firstKill = calls.findIndex(([, signal]) => signal === "SIGKILL");
    expect(firstKill).toBe(4);
    expect(calls.slice(0, firstKill).every(([, signal]) => signal === "SIGSTOP")).toBe(true);
    expect(calls.slice(firstKill)).toEqual(killed.map((pid) => [pid, "SIGKILL"]));
  });

  it("walks again after stopping, so a process started during the walk is killed too", () => {
    const later: Array<[number, number]> = [...table, [704, 703]];
    let reads = 0;
    const killed = bin.killProcessTree(700, {
      processTable: () => (reads++ === 0 ? table : later),
      kill: () => {},
      self: 600,
    });
    expect([...killed].sort()).toEqual([700, 701, 702, 703, 704]);
  });

  it("never signals itself or pid 1, and keeps going past a process that is already gone", () => {
    const calls: Array<[number, string]> = [];
    // This process below the root can only be pid reuse; it must still be skipped.
    const killed = bin.killProcessTree(700, {
      processTable: () => [...table, [600, 703]],
      kill: (pid, signal) => {
        if (pid === 701) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        calls.push([pid, signal]);
      },
      self: 600,
    });
    expect(killed).not.toContain(600);
    expect(calls.filter(([, s]) => s === "SIGKILL").map(([pid]) => pid).sort()).toEqual([700, 702, 703]);
    expect(bin.killProcessTree(1, { processTable: () => table, kill: () => {}, self: 600 })).toEqual([]);
  });

  it("kills the root alone when no process table can be read", () => {
    const calls: Array<[number, string]> = [];
    const killed = bin.killProcessTree(700, {
      processTable: () => null,
      kill: (pid, signal) => void calls.push([pid, signal]),
      self: 600,
    });
    expect(killed).toEqual([700]);
    expect(calls).toEqual([
      [700, "SIGSTOP"],
      [700, "SIGKILL"],
    ]);
  });

  const STARTED = "lstart:Fri Sep 11 18:00:00 2026";
  const withStarts = (rows: Array<[number, number]>): ProcessRow[] =>
    rows.map(([pid, ppid]) => [pid, ppid, STARTED]);
  const recorder = () => {
    const calls: Array<[number, string]> = [];
    return { calls, kill: (pid: number, signal: string) => void calls.push([pid, signal]) };
  };

  it("does not kill a pid handed to another process between the walk and the kill, and lets that process run on", () => {
    const found = withStarts(table);
    // 702 exited after the read that listed it, before its SIGSTOP, and its
    // pid now names an unrelated process that started later.
    const after: ProcessRow[] = found.map((row) =>
      row[0] === 702 ? [702, 800, "lstart:Fri Sep 11 18:00:05 2026"] : row,
    );
    let reads = 0;
    const { calls, kill } = recorder();
    const killed = bin.killProcessTree(700, {
      processTable: () => (reads++ === 0 ? found : after),
      kill,
      self: 600,
    });

    expect([...killed].sort()).toEqual([700, 701, 703]);
    expect(calls.filter(([pid]) => pid === 702)).toEqual([
      [702, "SIGSTOP"],
      [702, "SIGCONT"],
    ]);
    // Still everything stopped before anything is killed or resumed.
    const firstAfterStops = calls.findIndex(([, signal]) => signal !== "SIGSTOP");
    expect(firstAfterStops).toBe(4);
    expect(calls.slice(firstAfterStops).every(([, signal]) => signal !== "SIGSTOP")).toBe(true);
  });

  it("still kills a process re-parented after its parent was killed from outside, since its start time is unchanged", () => {
    const found = withStarts(table);
    const after: ProcessRow[] = found
      .filter(([pid]) => pid !== 701)
      .map((row) => (row[0] === 703 ? [703, 1, STARTED] : row));
    let reads = 0;
    const { calls, kill } = recorder();
    const killed = bin.killProcessTree(700, {
      processTable: () => (reads++ === 0 ? found : after),
      kill,
      self: 600,
    });
    expect([...killed].sort()).toEqual([700, 702, 703]);
    // 701 is gone by the check, so its pid is not signalled a second time.
    expect(calls.filter(([pid]) => pid === 701)).toEqual([[701, "SIGSTOP"]]);
    expect(calls.some(([, signal]) => signal === "SIGCONT")).toBe(false);
  });

  it("still kills every process when a step of the wall clock moves every start time, since none of them left the tree", () => {
    const found = withStarts(table);
    // Linux ps derives start times from the boot time, which a clock step moves for every process at once.
    const stepped: ProcessRow[] = table.map(([pid, ppid]) => [pid, ppid, "lstart:Fri Sep 11 18:00:01 2026"]);
    let reads = 0;
    const { calls, kill } = recorder();
    const killed = bin.killProcessTree(700, {
      processTable: () => (reads++ === 0 ? found : stepped),
      kill,
      self: 600,
    });
    expect([...killed].sort()).toEqual([700, 701, 702, 703]);
    expect(calls.some(([, signal]) => signal === "SIGCONT")).toBe(false);
  });

  it("kills a process that took a recycled pid inside the tree, since it is still below the root", () => {
    const found = withStarts(table);
    // 702 exited before its SIGSTOP, and 701 started a new child that was handed the same pid.
    const after: ProcessRow[] = found.map((row) =>
      row[0] === 702 ? [702, 701, "lstart:Fri Sep 11 18:00:05 2026"] : row,
    );
    let reads = 0;
    const { calls, kill } = recorder();
    const killed = bin.killProcessTree(700, {
      processTable: () => (reads++ === 0 ? found : after),
      kill,
      self: 600,
    });
    expect([...killed].sort()).toEqual([700, 701, 702, 703]);
    expect(calls.filter(([pid]) => pid === 702)).toEqual([
      [702, "SIGSTOP"],
      [702, "SIGKILL"],
    ]);
  });

  it("kills as before when start times cannot be compared: missing, or read from ps and then from /proc", () => {
    const found = withStarts(table);
    const after: ProcessRow[] = table.map(([pid, ppid]) =>
      pid === 701 ? [pid, ppid, "starttime:12345"] : pid === 702 ? [pid, ppid] : [pid, ppid, STARTED],
    );
    let reads = 0;
    const killed = bin.killProcessTree(700, {
      processTable: () => (reads++ === 0 ? found : after),
      kill: () => {},
      self: 600,
    });
    expect([...killed].sort()).toEqual([700, 701, 702, 703]);
  });

  it("checks the kill against a table read after the last SIGSTOP, even when the walk runs out of passes", () => {
    // Every read finds one more process below the last, so the walk never
    // settles on its own and has to read once more before killing.
    let reads = 0;
    const readAt: number[] = [];
    const { calls, kill } = recorder();
    const killed = bin.killProcessTree(700, {
      processTable: () => {
        const n = reads++;
        const rows: ProcessRow[] = [[700, 600, STARTED]];
        for (let i = 1; i <= n + 1; i++) rows.push([700 + i, 700 + i - 1, STARTED]);
        // Only that last read shows 701's pid naming a newer process outside the tree.
        if (n === 8) rows[1] = [701, 800, "lstart:Fri Sep 11 18:00:09 2026"];
        readAt.push(calls.length);
        return rows;
      },
      kill,
      self: 600,
    });
    expect(reads).toBe(9);
    expect(readAt[8]).toBe(calls.length - killed.length - 1);
    expect(killed).toContain(700);
    expect(killed).not.toContain(701);
    expect(calls.filter(([pid]) => pid === 701)).toEqual([
      [701, "SIGSTOP"],
      [701, "SIGCONT"],
    ]);
  });

  it("finds descendants at any depth and survives a malformed table with a cycle", () => {
    expect([...bin.descendantsOf(600, table)].sort()).toEqual([700, 701, 702, 703]);
    expect([...bin.descendantsOf(10, [[11, 10], [10, 11]])].sort()).toEqual([11]);
  });
});

describe("bin/libi.js processTable", () => {
  const fail = () => {
    throw new Error("ENOENT");
  };

  it("reads the pid, parent pid and start time columns of /bin/ps where /proc cannot be read", () => {
    const run = vi.fn(() => "    1     0 Wed Aug 26 01:47:01 2026    \n   42     1 Tue Sep  8 12:22:59 2026\n\n");
    expect(bin.processTable(run, { readdirSync: fail, readFileSync: fail })).toEqual([
      [1, 0, "lstart:Wed Aug 26 01:47:01 2026"],
      [42, 1, "lstart:Tue Sep 8 12:22:59 2026"],
    ]);
    expect(run).toHaveBeenCalledWith(
      "/bin/ps",
      ["-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart="],
      expect.anything(),
    );
  });

  it("falls back to /proc where ps cannot run, reading past a process name with spaces and parentheses", () => {
    const run = vi.fn(() => {
      throw new Error("ENOENT");
    });
    // Field 22, the start time, is the 20th after the name.
    const stats: Record<string, string> = {
      "/proc/1/stat": "1 (init) S 0 1 1 0 -1 4194560 100 200 0 0 5 6 0 0 20 0 1 0 7 1000 10",
      "/proc/4242/stat": "4242 (node (dev) x) S 1 4242 4242 0 -1 4194560 100 200 0 0 5 6 0 0 20 0 11 0 123456 1000 10\n",
      "/proc/77/stat": "77 (short) S 1 77 77",
    };
    const fsApi = {
      readdirSync: () => ["1", "self", "4242", "77", "9999"],
      readFileSync: (p: string) => {
        if (!(p in stats)) throw new Error("ENOENT");
        return stats[p];
      },
    };
    expect(bin.processTable(run, fsApi)).toEqual([
      [1, 0, "starttime:7"],
      [4242, 1, "starttime:123456"],
      [77, 1, undefined],
    ]);
  });

  it("reads /proc first wherever /proc/self/stat can be read, whose start times a step of the wall clock does not move", () => {
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
    expect(bin.processTable(run, { readdirSync: () => ["1", "self", "5"], readFileSync })).toEqual([
      [1, 0, "starttime:7"],
      [5, 1, "starttime:9"],
    ]);
    expect(run).not.toHaveBeenCalled();
    // A /proc that cannot be listed still leaves ps.
    expect(bin.processTable(run, { readdirSync: fail, readFileSync })).toEqual([[1, 0, "lstart:Wed Aug 26 01:47:01 2026"]]);
  });

  it("is null when neither ps nor /proc can be read", () => {
    expect(bin.processTable(fail, { readdirSync: fail, readFileSync: fail })).toBeNull();
  });

  it.skipIf(process.platform === "win32")("on this machine, lists this process under its real parent, with a start time that holds between reads", () => {
    const row = bin.processTable()?.find(([pid]) => pid === process.pid);
    expect(row).toEqual([process.pid, process.ppid, expect.stringMatching(/^(lstart|starttime):\S/)]);
    expect(bin.processTable()?.find(([pid]) => pid === process.pid)?.[2]).toBe(row?.[2]);
  });
});

describe.skipIf(process.platform === "win32")("bin/libi.js killProcessTree on real processes", () => {
  it("resumes a real process it stopped once the check shows its pid names a different process, and kills the tree", async () => {
    const script = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
    const victim = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    const bystander = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    const pids = [victim.pid as number, bystander.pid as number];
    const victimExited = new Promise<NodeJS.Signals | null>((resolve) =>
      victim.on("exit", (_code, signal) => resolve(signal)),
    );
    try {
      await waitFor(() => bin.processTable()?.some(([pid]) => pid === pids[1]) === true, "the bystander to be listed");
      // Read straight from ps, so the fixture does not lean on the table read under test.
      const lstart = String(
        execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pids[1])], { encoding: "utf-8" }),
      )
        .trim()
        .split(/\s+/)
        .join(" ");
      let reads = 0;
      const killed = bin.killProcessTree(pids[0], {
        // The real table, except that the first read lists the bystander as the
        // victim's child, the way a tree member whose pid was just reused would
        // be listed, and every later read shows that pid naming a newer process
        // under its real parent, outside the tree.
        processTable: () => {
          const rest = (bin.processTable() ?? []).filter(([pid]) => pid !== pids[1]);
          if (reads++ === 0) return [...rest, [pids[1], pids[0], `lstart:${lstart}`]];
          return [...rest, [pids[1], process.pid, "lstart:later"]];
        },
      });

      expect(killed).toEqual([pids[0]]);
      expect(await victimExited).toBe("SIGKILL");
      expect(isAlive(pids[1])).toBe(true);
      // Running again, not left stopped: ps shows a stopped process with a state starting with T.
      const state = () =>
        String(execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pids[1])], { encoding: "utf-8" })).trim();
      await waitFor(() => !state().startsWith("T"), "the bystander to be resumed");
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }, 20_000);
});
