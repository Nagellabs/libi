import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The desktop shell's login-shell environment probe against a REAL shell with fake profiles:
 * a chatty one, a hostile one, one that hangs, and ones that leave background jobs behind.
 * Everything the unit tests fake — the child, its timing, its output, the kill — is real here.
 * `HOME` (and `ZDOTDIR` for zsh) is a temp dir, so the user's own profile is never read.
 *
 * Every process a case starts must be dead when it ends: `afterEach` checks by pid (each
 * spawned shell, every member of its process group, and every pid a profile recorded), kills
 * any survivor by that pid, and fails the case. A pid is only ever treated as this case's when
 * its identity still matches — a spawned shell by the start time recorded when it was spawned,
 * anything else by this case's HOME in its command line, which every long-lived fixture process
 * carries — so a pid the system has since handed to an unrelated process is never signalled.
 */
const HAS_BASH = existsSync("/bin/bash");
const HAS_ZSH = existsSync("/bin/zsh");
const HAS_PERL = existsSync("/usr/bin/perl");

// A recording passthrough: the probe spawns the real shell, and the test learns its pid (which
// is also its process group id — every attempt runs in a group of its own) and its start time,
// read at once. The start time is what later tells that pid apart from a reused one.
const spawned = vi.hoisted(() => new Map<number, string | null>());
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]): ChildProcess => {
      const child = (actual.spawn as (...a: unknown[]) => ChildProcess)(...args);
      if (child.pid !== undefined) {
        let started: string | null = null;
        try {
          started = actual.execFileSync("ps", ["-o", "lstart=", "-p", String(child.pid)], { encoding: "utf8" }).trim() || null;
        } catch {
          /* already gone: nothing of it can survive the case */
        }
        spawned.set(child.pid, started);
      }
      return child;
    },
  };
});

let home: string;
let libiHome: string;
let snapshot: NodeJS.ProcessEnv;
let probe: typeof import("../../../electron/path-bootstrap") | null = null;

beforeEach(() => {
  snapshot = { ...process.env };
  spawned.clear();
  home = mkdtempSync(path.join(os.tmpdir(), "libi-env-probe-home-"));
  libiHome = mkdtempSync(path.join(os.tmpdir(), "libi-env-probe-libi-"));
  process.env.HOME = home;
  process.env.LIBI_HOME = libiHome;
  process.env.SHELL = "/bin/bash";
  process.env.PATH = "/usr/bin:/bin";
  // The merge is add-only: a runner whose own env already carries one of these would
  // turn the hostile / normal cases red. `afterEach` restores the snapshot.
  for (const k of [
    "PROBE_IT_NORMAL", "PROBE_IT_HOSTILE", "NODE_OPTIONS", "PYTHONHOME", "ELECTRON_RUN_AS_NODE",
    "EXISTING_PROBE", "PROBE_IT_SLOW", "PROBE_IT_ZSH", "PROBE_IT_BACKGROUND", "PROBE_IT_ESCAPED",
    "ZDOTDIR", "LIBI_SHELL_ENV",
  ]) delete process.env[k];
  // Positive control for every liveness helper below. They all read `psRow`, so a `ps` whose
  // lstart column stopped matching its regex would make every "dead" / "no survivors" assertion
  // in this file pass vacuously. This process is alive: its row must parse, and its start time
  // must read exactly as the recording spawn mock reads one, or `isSpawnedShell` never matches.
  const self = psRow(process.pid);
  expect(self, "psRow parses a process known to be alive").not.toBeNull();
  expect(isAlive(process.pid)).toBe(true);
  expect(self!.started).toBe(
    execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" }).trim().replace(/\s+/g, " "),
  );
});
afterEach(() => {
  probe?.stopShellEnvProbe();
  probe = null;
  const survivors = survivingProcesses();
  for (const pid of survivors) {
    try {
      process.kill(pid, "SIGKILL"); // by pid, and only a process this case started
    } catch {
      /* already gone */
    }
  }
  process.env = snapshot;
  rmSync(home, { recursive: true, force: true });
  rmSync(libiHome, { recursive: true, force: true });
  expect(survivors, "processes this case started that were still alive when it ended").toEqual([]);
});

async function freshBootstrap() {
  vi.resetModules(); // a fresh module per case: one probe loop per module
  probe = await import("../../../electron/path-bootstrap");
  return probe;
}

/** Wait for the probe to settle, but never longer than `ms` — a regression then fails on
 *  the state assertion that follows instead of hanging the case. */
async function settleWithin(probeSettled: Promise<void>, ms: number): Promise<void> {
  await Promise.race([probeSettled, new Promise<void>((r) => setTimeout(r, ms).unref())]);
}

/** `ps` for one pid: `[stat, pgid, start time, command]`, or null when there is no such process. Read-only. */
function psRow(pid: number): { stat: string; pgid: number; started: string; command: string } | null {
  try {
    const row = execFileSync("ps", ["-o", "stat=,pgid=,lstart=,command=", "-p", String(pid)], { encoding: "utf8" }).trim();
    // `lstart` is five fields on both macOS and procps: `Fri Sep 11 12:22:03 2026`.
    const m = /^(\S+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(row);
    return m ? { stat: m[1], pgid: Number(m[2]), started: m[3].replace(/\s+/g, " "), command: m[4] } : null;
  } catch {
    return null; // ps exits 1 when there is no such pid
  }
}

/** True for a live process; a zombie counts as dead. Read-only (`ps`) — never signals anything. */
function isAlive(pid: number): boolean {
  const row = psRow(pid);
  return row !== null && !row.stat.startsWith("Z");
}

async function deadWithin(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

/** A pid a profile wrote into the temp HOME, or null. */
function recordedPid(name: string): number | null {
  const file = path.join(home, name);
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, "utf8").trim().split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** A live process whose command line carries this case's HOME — every long-lived fixture does. */
function isFixtureProcess(pid: number): boolean {
  const row = psRow(pid);
  return row !== null && !row.stat.startsWith("Z") && row.command.includes(home);
}

/** A live spawned shell that is still the process spawned: same pid AND the same start time. */
function isSpawnedShell(pid: number): boolean {
  const started = spawned.get(pid);
  const row = psRow(pid);
  return started != null && row !== null && !row.stat.startsWith("Z") && row.started === started.replace(/\s+/g, " ");
}

/**
 * Live processes this case started, each confirmed by identity rather than by pid alone: every
 * spawned shell, every member of a process group one of them led, and every pid a profile
 * recorded. A pid that no longer matches belongs to someone else by now and is left alone.
 */
function survivingProcesses(): number[] {
  const alive = new Set<number>();
  for (const pid of spawned.keys()) if (isSpawnedShell(pid)) alive.add(pid);
  if (spawned.size > 0) {
    const table = execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8" });
    for (const line of table.split("\n")) {
      const [pid, pgid, stat] = line.trim().split(/\s+/);
      if (!pid || !stat || stat.startsWith("Z") || !spawned.has(Number(pgid))) continue;
      if (isSpawnedShell(Number(pid)) || isFixtureProcess(Number(pid))) alive.add(Number(pid));
    }
  }
  for (const file of ["sleep.pid", "background.pid", "escaped.pid"]) {
    const pid = recordedPid(file);
    if (pid !== null && isFixtureProcess(pid)) alive.add(pid);
  }
  return [...alive];
}

function syncLog(): string {
  return readFileSync(path.join(libiHome, "logs", "electron-main-sync.log"), "utf8");
}

describe.skipIf(!HAS_BASH)("login-shell environment probe — real bash", () => {
  it("normal profile: a banner does not corrupt the capture; PATH and an export arrive; state `loaded`", async () => {
    writeFileSync(
      path.join(home, ".bash_profile"),
      'echo "Welcome to a chatty profile"\nexport PATH="/opt/fromprofile/bin:$PATH"\nexport PROBE_IT_NORMAL=arrived\n',
    );
    const { bootstrapPath } = await freshBootstrap();
    const { probeSettled } = bootstrapPath();
    await settleWithin(probeSettled, 6_000);
    expect(process.env.LIBI_SHELL_ENV).toBe("loaded");
    expect(process.env.PROBE_IT_NORMAL).toBe("arrived");
    expect(process.env.PATH!.split(":")).toContain("/opt/fromprofile/bin");
    const cache = JSON.parse(readFileSync(path.join(libiHome, "shell-path-cache.json"), "utf8"));
    expect(Object.keys(cache).sort()).toEqual(["path", "shell"]);
  }, 10_000);

  it("hostile profile: blocklisted names never land, an existing value is never overwritten", async () => {
    process.env.EXISTING_PROBE = "mine";
    writeFileSync(
      path.join(home, ".bash_profile"),
      [
        "export LIBI_HOME=/evil",
        "export NODE_OPTIONS=--require=/evil.js",
        "export PYTHONHOME=/evil/py",
        "export ELECTRON_RUN_AS_NODE=1",
        "export EXISTING_PROBE=theirs",
        "export PROBE_IT_HOSTILE=fine",
        "printf 'garbage\\0with\\0nuls'",
        "",
      ].join("\n"),
    );
    const { bootstrapPath } = await freshBootstrap();
    const { probeSettled } = bootstrapPath();
    await settleWithin(probeSettled, 6_000);
    expect(process.env.LIBI_SHELL_ENV).toBe("loaded");
    expect(process.env.LIBI_HOME).toBe(libiHome);
    expect(process.env.NODE_OPTIONS).toBeUndefined();
    expect(process.env.PYTHONHOME).toBeUndefined();
    expect(process.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(process.env.EXISTING_PROBE).toBe("mine");
    expect(process.env.PROBE_IT_HOSTILE).toBe("fine");
  }, 10_000);

  it("hanging profile: boot is not held, the timed-out shell AND its `sleep` child are dead (by pid) before the next attempt starts, and attempt 2 loads", async () => {
    writeFileSync(
      path.join(home, ".bash_profile"),
      [
        'if [ ! -f "$HOME/.slept" ]; then',
        '  : > "$HOME/.slept"',
        '  echo $$ > "$HOME/shell.pid"',
        // `trap "" TERM` survives exec: this sleep ignores SIGTERM, so only SIGKILL ends it. Its
        // command line names this case's HOME before the exec ($0) and after it (argv[0]), which
        // is how cleanup tells it from an unrelated process that later got the same pid.
        "  /bin/bash -c 'trap \"\" TERM; echo $$ > \"$0/sleep.pid\"; exec -a \"$0/fixture-sleep\" sleep 30' \"$HOME\"",
        "fi",
        // Attempt 2 reaches here: record anything of attempt 1 still alive AT THIS MOMENT.
        "for f in shell.pid sleep.pid; do",
        '  st=$(ps -o stat= -p "$(cat "$HOME/$f")" 2>/dev/null)',
        '  case "$st" in ""|Z*) ;; *) echo "$f" >> "$HOME/alive-at-next-attempt" ;; esac',
        "done",
        "export PROBE_IT_SLOW=second-attempt",
        "",
      ].join("\n"),
    );
    const { bootstrapPath, SHELL_PROBE_TIMEOUT_MS, SHELL_PROBE_KILL_GRACE_MS, SHELL_PROBE_BACKOFF_MS } =
      await freshBootstrap();
    const started = Date.now();
    const { probeSettled } = bootstrapPath();
    expect(Date.now() - started).toBeLessThan(200); // the caller is never held
    // Seen ALIVE first, through the same helpers, while attempt 1 is still inside its timeout (the
    // sleep ignores SIGTERM, so only the SIGKILL after it ends it) — so "dead" below is the kill.
    for (const until = Date.now() + SHELL_PROBE_TIMEOUT_MS; recordedPid("sleep.pid") === null && Date.now() < until; ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const liveSleep = recordedPid("sleep.pid");
    expect(liveSleep, "attempt 1's sleep recorded its pid before the timeout").not.toBeNull();
    expect(isAlive(liveSleep!), "attempt 1's sleep, before the kill").toBe(true);
    expect(isFixtureProcess(liveSleep!), "attempt 1's sleep carries this case's HOME").toBe(true);
    await settleWithin(probeSettled, 15_000);
    const elapsed = Date.now() - started;

    expect(process.env.LIBI_SHELL_ENV).toBe("loaded");
    expect(process.env.PROBE_IT_SLOW).toBe("second-attempt");
    const shellPid = Number(readFileSync(path.join(home, "shell.pid"), "utf8"));
    const sleepPid = Number(readFileSync(path.join(home, "sleep.pid"), "utf8"));
    expect(shellPid).toBeGreaterThan(0);
    expect(sleepPid).toBeGreaterThan(0);
    expect(isAlive(shellPid), "attempt 1's shell").toBe(false);
    expect(isAlive(sleepPid), "attempt 1's sleep").toBe(false);
    // Written BY attempt 2 while it ran: nothing of attempt 1 was alive when it started.
    expect(existsSync(path.join(home, "alive-at-next-attempt"))).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(
      SHELL_PROBE_TIMEOUT_MS + SHELL_PROBE_KILL_GRACE_MS + SHELL_PROBE_BACKOFF_MS[0] - 50,
    );
    expect(syncLog()).toMatch(/attempt=1 cause=timeout pathApplied=false exited=true\n/);
    expect(syncLog()).toMatch(
      // Whether attempt 2's group still had a member to kill after its capture is the real
      // shell's timing, not something this case controls: the field is checked, not its value.
      /shell_env_probe_done state=loaded attempts=2 failures=1 killed=1 killedAfterSuccess=\d+ notExitedAfterKill=0 /,
    );
  }, 20_000);

  it("a background job that ignores SIGTERM outlives a shell that finished its capture: `loaded` at once, the group's SIGKILL ends the job (dead by pid), and a member dying of it is not counted as a survivor", async () => {
    writeFileSync(
      path.join(home, ".bash_profile"),
      [
        // Inherits stdout, so the pipe stays open after the shell exits; ignores SIGTERM. Named by
        // this case's HOME in its command line, like the hanging profile's sleep.
        "/bin/bash -c 'trap \"\" TERM; echo $$ > \"$0/background.pid\"; exec -a \"$0/fixture-sleep\" sleep 30' \"$HOME\" &",
        // The capture must not finish before the job is set up, or the group signal after it
        // ends the job before its trap exists. Its pid lands only after the trap is in place.
        'for i in $(seq 1 200); do [ -s "$HOME/background.pid" ] && break; sleep 0.01; done',
        "export PROBE_IT_BACKGROUND=arrived",
        "",
      ].join("\n"),
    );
    const { bootstrapPath } = await freshBootstrap();
    const started = Date.now();
    const { probeSettled } = bootstrapPath();
    await settleWithin(probeSettled, 6_000);
    expect(process.env.LIBI_SHELL_ENV).toBe("loaded");
    expect(process.env.PROBE_IT_BACKGROUND).toBe("arrived");
    const jobPid = recordedPid("background.pid");
    expect(jobPid).not.toBeNull();
    expect(isAlive(jobPid!), "the profile's background job").toBe(false);
    expect(Date.now() - started).toBeLessThan(6_000); // the open pipe held nothing up
    expect(syncLog()).toMatch(
      /shell_env_probe_done state=loaded attempts=1 failures=0 killed=0 killedAfterSuccess=1 notExitedAfterKill=0 /,
    );
  }, 10_000);

  it.skipIf(!HAS_PERL)(
    "a job that escaped the group and keeps writing to the probe's stdout: `loaded` without waiting on the pipe, and once the attempt settles our end is closed, so the job dies of the broken pipe",
    async () => {
      writeFileSync(
        path.join(home, ".bash_profile"),
        [
          // setsid: out of the attempt's group, where no group signal reaches it. It waits for the
          // shell to exit (so nothing lands inside the capture), then writes to the inherited
          // stdout until it cannot — or for at most 15 s.
          "perl -e '",
          "  use POSIX (); defined(POSIX::setsid()) or exit 1;",
          '  open(my $f, ">", "$ARGV[0]/escaped.pid") or exit 1; print $f "$$ " . getpgrp(); close $f;',
          "  $| = 1; my $end = time + 15;",
          "  select(undef, undef, undef, 0.05) while kill(0, $ARGV[1]) && time < $end;",
          '  while (time < $end) { print "x\\n" or exit 0; select(undef, undef, undef, 0.05) }',
          "' \"$HOME\" \"$$\" &",
          // Its pid lands only once it has left the group; before that a group signal still reaches it.
          'for i in $(seq 1 200); do [ -s "$HOME/escaped.pid" ] && break; sleep 0.01; done',
          "export PROBE_IT_ESCAPED=arrived",
          "",
        ].join("\n"),
      );
      const { bootstrapPath } = await freshBootstrap();
      const { probeSettled } = bootstrapPath();
      await settleWithin(probeSettled, 6_000);
      expect(process.env.LIBI_SHELL_ENV).toBe("loaded");
      expect(process.env.PROBE_IT_ESCAPED).toBe("arrived");
      const [pid, pgid] = readFileSync(path.join(home, "escaped.pid"), "utf8").trim().split(/\s+/).map(Number);
      expect(pgid, "the job leads a group of its own").toBe(pid);
      expect(spawned.has(pgid)).toBe(false);
      expect(await deadWithin(pid, 3_000), "the escaped writer, once our end of the pipe is closed").toBe(true);
      expect(syncLog()).toMatch(
        // The escaped writer is outside the group; whether the shell itself was still exiting when
        // the group was signalled is real-shell timing, so only the field's presence is pinned.
        /shell_env_probe_done state=loaded attempts=1 failures=0 killed=0 killedAfterSuccess=\d+ notExitedAfterKill=0 /,
      );
    },
    10_000,
  );
});

describe.skipIf(!HAS_ZSH)("login-shell environment probe — real zsh via ZDOTDIR", () => {
  it("normal profile under zsh", async () => {
    process.env.SHELL = "/bin/zsh";
    process.env.ZDOTDIR = home;
    writeFileSync(path.join(home, ".zshrc"), 'echo "zsh banner"\n');
    writeFileSync(path.join(home, ".zprofile"), 'export PROBE_IT_ZSH=arrived\nexport PATH="/opt/zprofile/bin:$PATH"\n');
    const { bootstrapPath } = await freshBootstrap();
    const { probeSettled } = bootstrapPath();
    await settleWithin(probeSettled, 6_000);
    expect(process.env.LIBI_SHELL_ENV).toBe("loaded");
    expect(process.env.PROBE_IT_ZSH).toBe("arrived");
    expect(process.env.PATH!.split(":")).toContain("/opt/zprofile/bin");
  }, 10_000);
});
