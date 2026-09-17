import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/logger", () => ({ serverLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

/**
 * The login-shell probe's kill rule against a REAL shell. The profile hangs in a
 * `sleep` that ignores SIGTERM (an interactive bash ignores SIGTERM too), so only
 * the group SIGKILL ends it. `HOME` is a temp dir so the user's own profile is
 * never read.
 */
const HAS_BASH = existsSync("/bin/bash");

let home: string;
let snapshot: NodeJS.ProcessEnv;

/** Pids the profile wrote down; after a test, one still running a fixture command is SIGKILLed by pid. */
let startedPids: number[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  snapshot = { ...process.env };
  home = mkdtempSync(path.join(os.tmpdir(), "libi-login-shell-kill-"));
  process.env.HOME = home;
  process.env.SHELL = "/bin/bash";
  process.env.PATH = "/usr/bin:/bin";
});
afterEach(() => {
  for (const pid of startedPids) killIfFixture(pid);
  startedPids = [];
  process.env = snapshot;
  rmSync(home, { recursive: true, force: true });
});

/**
 * True for a live process; a zombie counts as dead. Read-only (`ps`) — never
 * signals anything. A copy of the desktop probe test's helper: importing that
 * test file would register its suites here.
 */
function isAlive(pid: number): boolean {
  try {
    const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return stat.length > 0 && !stat.startsWith("Z");
  } catch {
    return false; // ps exits 1 when there is no such pid
  }
}

/** The command line of `pid`, or null when there is no such process. Read-only (`ps`). */
function commandOf(pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Cleanup never signals a process this file did not start: a pid is SIGKILLed only
 * while it is alive AND still runs a fixture command — the profile's `sleep 30`, or
 * the probe's shell (its command carries the probe's marker). A recycled pid is left alone.
 */
function killIfFixture(pid: number): void {
  if (!isAlive(pid)) return;
  const cmd = commandOf(pid);
  if (cmd === null) return;
  const exe = path.basename(cmd.split(/\s+/)[0] ?? "").replace(/^-/, "");
  const ours = /^(\S*\/)?sleep 30$/.test(cmd) || ((exe === "bash" || exe === "sh") && cmd.includes("__LIBI_PATH_START__"));
  if (!ours) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* exited between the check and the signal */
  }
}

describe.skipIf(!HAS_BASH)("loginShellPathDirs — a hanging profile is killed, never left running (real bash)", () => {
  it("after the timeout NEITHER the shell NOR its SIGTERM-proof `sleep` is alive (by pid), the caller gets [] within the kill budget, and nothing survived", async () => {
    writeFileSync(
      path.join(home, ".bash_profile"),
      [
        'echo $$ > "$HOME/shell.pid"',
        // `trap "" TERM` survives exec: this sleep ignores SIGTERM, so only SIGKILL ends it.
        "sh -c 'trap \"\" TERM; echo $$ > \"$HOME/sleep.pid\"; exec sleep 30'",
        "",
      ].join("\n"),
    );
    const m = await import("@/lib/agents/cli/login-shell-path");
    m.__clearLoginShellPathMemo();
    const started = Date.now();
    const dirs = await m.loginShellPathDirs({ platform: process.platform });
    const elapsed = Date.now() - started;

    expect(dirs).toEqual([]);
    const shellPid = Number(readFileSync(path.join(home, "shell.pid"), "utf8"));
    const sleepPid = Number(readFileSync(path.join(home, "sleep.pid"), "utf8"));
    startedPids.push(shellPid, sleepPid);
    expect(shellPid).toBeGreaterThan(0);
    expect(sleepPid).toBeGreaterThan(0);
    expect(isAlive(shellPid), "the probe's shell").toBe(false);
    expect(isAlive(sleepPid), "the profile's sleep").toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(m.LOGIN_SHELL_PROBE_TIMEOUT_MS + m.LOGIN_SHELL_PROBE_KILL_GRACE_MS - 50);
    expect(elapsed).toBeLessThan(
      m.LOGIN_SHELL_PROBE_TIMEOUT_MS + m.LOGIN_SHELL_PROBE_KILL_GRACE_MS + m.LOGIN_SHELL_PROBE_EXIT_WAIT_MS + 500,
    );
    const { serverLogger } = await import("@/lib/logger");
    expect(vi.mocked(serverLogger.warn)).toHaveBeenCalledWith(
      { tag: "agent-cli", op: "login_shell_probe_timeout", killed: 1, notExitedAfterKill: 0 },
      expect.any(String),
    );
  }, 10_000);

  it("a profile whose background job holds stdout open: the PATH arrives before the timeout, then the job (SIGTERM-proof) is killed by its group (by pid)", async () => {
    writeFileSync(
      path.join(home, ".bash_profile"),
      [
        'echo $$ > "$HOME/shell.pid"',
        // Backgrounded with stdout inherited: the pipe stays open after the shell exits.
        "sh -c 'trap \"\" TERM; echo $$ > \"$HOME/bg.pid.tmp\"; mv \"$HOME/bg.pid.tmp\" \"$HOME/bg.pid\"; exec sleep 30' &",
        // Only once the job has its trap in place (it wrote its pid) does the probe's command run.
        'while [ ! -s "$HOME/bg.pid" ]; do sleep 0.05; done',
        "",
      ].join("\n"),
    );
    const m = await import("@/lib/agents/cli/login-shell-path");
    m.__clearLoginShellPathMemo();
    const started = Date.now();
    const dirs = await m.loginShellPathDirs({ platform: process.platform });
    const elapsed = Date.now() - started;

    expect(dirs.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(m.LOGIN_SHELL_PROBE_TIMEOUT_MS);
    const shellPid = Number(readFileSync(path.join(home, "shell.pid"), "utf8"));
    const bgPid = Number(readFileSync(path.join(home, "bg.pid"), "utf8"));
    startedPids.push(shellPid, bgPid);
    expect(bgPid).toBeGreaterThan(0);
    const budget = m.LOGIN_SHELL_PROBE_EXIT_CHANCE_MS + m.LOGIN_SHELL_PROBE_KILL_GRACE_MS + m.LOGIN_SHELL_PROBE_EXIT_WAIT_MS;
    await vi.waitFor(
      () => {
        expect(isAlive(shellPid), "the probe's shell").toBe(false);
        expect(isAlive(bgPid), "the profile's background job").toBe(false);
      },
      { timeout: budget + 1_000, interval: 50 },
    );
    const { serverLogger } = await import("@/lib/logger");
    // A profile that backgrounds work is normal: its end is debug; only a survivor would be a warning.
    await vi.waitFor(() =>
      expect(vi.mocked(serverLogger.debug)).toHaveBeenCalledWith(
        { tag: "agent-cli", op: "login_shell_probe_group_ended", killed: 1, notExitedAfterKill: 0 },
        expect.any(String),
      ),
    );
    expect(vi.mocked(serverLogger.warn)).not.toHaveBeenCalledWith(expect.objectContaining({ op: "login_shell_probe_group_ended" }), expect.anything());
    expect(vi.mocked(serverLogger.warn)).not.toHaveBeenCalledWith(expect.objectContaining({ op: "login_shell_probe_timeout" }), expect.anything());
  }, 10_000);
});
