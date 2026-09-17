import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * The forced end of `npx @nagellabs/libi` and of `npm run dev` both kill a
 * process tree, from two copies of the same code: `killProcessTree` and
 * `processTable` in bin/libi.js, and `killDevProcessTree` and
 * `readProcessTable` in lib/cli/studio.ts.
 *
 * They cannot be one module. bin/libi.js is plain JS that has to run without a
 * build, and studio.ts ships compiled into dist-cli/, which carries only
 * compiled TypeScript: a plain JS file under lib/ is never copied there, and a
 * require of bin/ from the compiled file would point one directory off. So the
 * copies stay separate, and this file runs the same fixtures through both.
 * They had already drifted once: the dev copy had no /proc fallback, so a dev
 * checkout without ps killed npx alone and orphaned the server.
 */

vi.mock("@/lib/server/lifecycle", () => ({ runInstallPhase: vi.fn() }));
vi.mock("@/lib/server/lifecycle/adapters/cli", () => ({ cliAdapter: vi.fn(() => ({})) }));

import { killDevProcessTree, readProcessTable, type ProcessRow } from "@/lib/cli/studio";

const BIN_PATH = path.resolve(__dirname, "..", "..", "..", "bin", "libi.js");

type Table = ProcessRow[] | null;
type KillOpts = {
  processTable: () => Table;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  self: number;
};
type ProcFs = {
  readdirSync: (p: string) => string[];
  readFileSync: (p: string, enc: "utf-8") => string;
};
type Run = (file: string, args: string[], options: never) => string;

const bin = createRequire(BIN_PATH)(BIN_PATH) as {
  killProcessTree: (rootPid: number, opts: KillOpts) => number[];
  processTable: (run: Run, fsApi: ProcFs) => Table;
};

const S = "lstart:Fri Sep 11 18:00:00 2026";
const LATER = "lstart:Fri Sep 11 18:00:07 2026";

/** A process tree as the launcher sees it: npm above, the launcher, the server's tree, and bystanders. */
const tree: ProcessRow[] = [
  [1, 0, S],
  [500, 1, S],
  [600, 500, S],
  [700, 600, S],
  [701, 700, S],
  [702, 700, S],
  [703, 701, S],
  [800, 1, S],
  [900, 500, S],
];
const without = (pids: number[], rows = tree) => rows.filter(([pid]) => !pids.includes(pid));
const replace = (row: ProcessRow, rows = tree) => rows.map((r) => (r[0] === row[0] ? row : r));

type TreeScenario = {
  name: string;
  root: number;
  self?: number;
  /** The table each successive read returns, by read index. */
  read: (n: number) => Table;
  /** Pids whose signals throw, as for a process that is already gone. */
  gone?: number[];
  /** The pids the kill must end with, for scenarios that pin the outcome as well as the parity. */
  killed?: number[];
};

const treeScenarios: TreeScenario[] = [
  { name: "a settled tree", root: 700, read: () => tree },
  { name: "rows without start times", root: 700, read: () => tree.map(([pid, ppid]) => [pid, ppid]) },
  { name: "a child started during the walk", root: 700, read: (n) => (n === 0 ? tree : [...tree, [704, 703, S]]) },
  {
    name: "a pid reused between the walk and the kill",
    root: 700,
    read: (n) => (n === 0 ? tree : replace([702, 800, LATER])),
  },
  {
    // A step of the wall clock moves every start time Linux ps prints, since it
    // derives them from the boot time, but none of these processes left the tree.
    name: "a clock step that moves every start time inside the tree",
    root: 700,
    read: (n) => (n === 0 ? tree : tree.map(([pid, ppid]) => [pid, ppid, LATER] as ProcessRow)),
    killed: [700, 701, 702, 703],
  },
  {
    name: "a recycled pid taken by a new process inside the tree",
    root: 700,
    read: (n) => (n === 0 ? tree : replace([702, 701, LATER])),
    killed: [700, 701, 702, 703],
  },
  {
    name: "a process re-parented after its parent was killed from outside",
    root: 700,
    read: (n) => (n === 0 ? tree : replace([703, 1, S], without([701]))),
  },
  { name: "a pid gone by the check", root: 700, read: (n) => (n === 0 ? tree : without([702])) },
  {
    name: "start times from ps, then from /proc",
    root: 700,
    read: (n) => (n === 0 ? tree : replace([701, 700, "starttime:4242"])),
  },
  { name: "no process table at all", root: 700, read: () => null },
  { name: "a table that cannot be read again for the check", root: 700, read: (n) => (n === 0 ? tree : null) },
  {
    name: "a walk that runs out of passes",
    root: 700,
    read: (n) => {
      const rows: ProcessRow[] = [[700, 600, S]];
      for (let i = 1; i <= n + 1; i++) rows.push([700 + i, 699 + i, S]);
      // Only the extra read shows 701's pid naming a newer process outside the tree.
      if (n === 8) rows[1] = [701, 800, LATER];
      return rows;
    },
  },
  {
    name: "itself and pid 1 below the root, and a process already gone",
    root: 700,
    read: () => [...tree, [600, 703, S], [1, 702, S]],
    gone: [701],
  },
  { name: "pid 1 as the root", root: 1, read: () => tree },
  { name: "a root that is not an integer", root: 700.5, read: () => tree },
];

function runTreeKill(impl: (root: number, opts: KillOpts) => number[], scenario: TreeScenario) {
  const calls: Array<[string, number, string?]> = [];
  let reads = 0;
  const killed = impl(scenario.root, {
    processTable: () => {
      calls.push(["read", reads]);
      return scenario.read(reads++);
    },
    kill: (pid, signal) => {
      calls.push(["kill", pid, signal]);
      if (scenario.gone?.includes(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    },
    self: scenario.self ?? 600,
  });
  return { killed, calls };
}

describe("the launcher's and the dev CLI's tree kills behave identically", () => {
  it.each(treeScenarios.map((s) => [s.name, s] as const))("%s", (_name, scenario) => {
    const fromBin = runTreeKill(bin.killProcessTree, scenario);
    const fromDev = runTreeKill(killDevProcessTree, scenario);
    expect(fromDev).toEqual(fromBin);
    if (scenario.killed) expect([...fromBin.killed].sort()).toEqual(scenario.killed);
  });

  it("the fixtures reach every branch: a kill, a resume, a pid left alone, and an unchecked kill", () => {
    const signals = treeScenarios.flatMap((s) => runTreeKill(bin.killProcessTree, s).calls);
    expect(signals).toContainEqual(["kill", 702, "SIGCONT"]);
    expect(signals).toContainEqual(["kill", 700, "SIGKILL"]);
    const byName = (name: string) => treeScenarios.find((s) => s.name === name)!;
    const reusedRun = runTreeKill(bin.killProcessTree, byName("a pid reused between the walk and the kill"));
    expect(reusedRun.killed).not.toContain(702);
    const noTable = runTreeKill(bin.killProcessTree, byName("no process table at all"));
    expect(noTable.killed).toEqual([700]);
  });
});

type TableScenario = { name: string; ps: () => string; proc?: Record<string, string>; dir?: string[] };

const fail = () => {
  throw new Error("ENOENT");
};
const procStat = (pid: number, name: string, ppid: number, start: number) =>
  `${pid} (${name}) S ${ppid} ${pid} ${pid} 0 -1 4194560 100 200 0 0 5 6 0 0 20 0 1 0 ${start} 1000 10\n`;

const tableScenarios: TableScenario[] = [
  {
    name: "ps with padded start times",
    ps: () => "    1     0 Wed Aug 26 01:47:01 2026    \n  367  1208 Tue Sep  8 12:22:59 2026\n\n",
  },
  { name: "ps printing no start time column", ps: () => "    1     0\n   42     1\n" },
  { name: "ps with a malformed line", ps: () => "PID PPID STARTED\n   42     1 Fri Sep 11 18:20:48 2026\nx y\n" },
  {
    name: "no ps: /proc, past names with spaces and parentheses",
    ps: fail,
    dir: ["1", "self", "4242", "77", "9999"],
    proc: {
      "/proc/1/stat": procStat(1, "init", 0, 7),
      "/proc/4242/stat": procStat(4242, "node (dev) x)", 1, 123456),
      "/proc/77/stat": "77 (short) S 1 77 77",
    },
  },
  { name: "ps printing nothing: /proc", ps: () => "\n", dir: ["5"], proc: { "/proc/5/stat": procStat(5, "a", 1, 9) } },
  { name: "neither ps nor /proc", ps: fail },
  {
    name: "/proc/self/stat readable: /proc first, and ps never runs",
    ps: () => "    1     0 Wed Aug 26 01:47:01 2026\n",
    dir: ["1", "self", "5"],
    proc: {
      "/proc/self/stat": procStat(5, "a", 1, 9),
      "/proc/1/stat": procStat(1, "init", 0, 7),
      "/proc/5/stat": procStat(5, "a", 1, 9),
    },
  },
  {
    name: "/proc/self/stat readable but /proc cannot be listed: ps",
    ps: () => "    1     0 Wed Aug 26 01:47:01 2026\n",
    proc: { "/proc/self/stat": procStat(5, "a", 1, 9) },
  },
];

function runTableRead(impl: (run: Run, fsApi: ProcFs) => Table, scenario: TableScenario) {
  const runCalls: unknown[][] = [];
  const run = ((...args: unknown[]) => {
    runCalls.push(args);
    return scenario.ps();
  }) as Run;
  const fsApi: ProcFs = {
    readdirSync: () => (scenario.dir ? scenario.dir : fail()),
    readFileSync: (p) => {
      if (!scenario.proc || !(p in scenario.proc)) return fail();
      return scenario.proc[p];
    },
  };
  return { table: impl(run, fsApi), runCalls };
}

describe("the launcher's and the dev CLI's process table reads behave identically", () => {
  it.each(tableScenarios.map((s) => [s.name, s] as const))("%s", (_name, scenario) => {
    const fromBin = runTableRead(bin.processTable, scenario);
    const fromDev = runTableRead(readProcessTable as unknown as (run: Run, fsApi: ProcFs) => Table, scenario);
    expect(fromDev).toEqual(fromBin);
  });

  it("the fixtures reach both sources and the empty result", () => {
    const tables = tableScenarios.map((s) => runTableRead(bin.processTable, s).table);
    expect(tables[0]).toContainEqual([367, 1208, "lstart:Tue Sep 8 12:22:59 2026"]);
    expect(tables[3]).toContainEqual([4242, 1, "starttime:123456"]);
    expect(tables[5]).toBeNull();
    const procFirst = runTableRead(bin.processTable, tableScenarios[6]);
    expect(procFirst.runCalls).toEqual([]);
    expect(procFirst.table).toEqual([
      [1, 0, "starttime:7"],
      [5, 1, "starttime:9"],
    ]);
    expect(runTableRead(bin.processTable, tableScenarios[7]).table).toEqual([[1, 0, "lstart:Wed Aug 26 01:47:01 2026"]]);
  });

  it.skipIf(process.platform === "win32")("on this machine, both read the same row for this process", () => {
    const fromBin = (bin.processTable as unknown as () => Table)()?.find(([pid]) => pid === process.pid);
    const fromDev = readProcessTable()?.find(([pid]) => pid === process.pid);
    expect(fromBin).toBeDefined();
    expect(fromDev).toEqual(fromBin);
  });
});
