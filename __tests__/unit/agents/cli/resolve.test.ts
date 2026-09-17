import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, type spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENT_CLI_MEMO_MS, AGENT_CLI_VERSION_TIMEOUT_MS, invalidateAgentCliMemo, isUsableCli, knownInstallDirs, resolveAgentCli, runCliVersion, testAgentCliDirs,
} from "@/lib/agents/cli/resolve";
import { GROUP_EXIT_WAIT_MS, GROUP_KILL_GRACE_MS } from "@/lib/agents/cli/process-group";
import { resolveCmdShimNativeTarget } from "@/lib/agents/cli/spawn-shape";
import { codexAppBundleDirs } from "@/lib/agents/user-cli";
import { serverLogger } from "@/lib/logger";

/**
 * Fixture "CLIs" are tiny shell scripts, so every posix case here runs the
 * REAL spawn/realpath/--version path. Windows cases inject the pieces that
 * cannot run on this host: found, not found, libi-internal rejected,
 * symlink / fnm realpath, below minimum, broken binary, timeout, Windows .cmd.
 */
let dir: string;
const MIN = { "claude-code": "2.1.245", codex: "0.153.0" } as const;
/** The `--version` bound: a caller is never kept waiting past it. */
const VERSION_BOUND_MS = 3_000;
/** After the bound: SIGTERM to the group, SIGKILL after the grace, then at most the exit wait. */
const KILL_BUDGET_MS = GROUP_KILL_GRACE_MS + GROUP_EXIT_WAIT_MS;
/** Pids a fixture wrote down; after a test, one still running a fixture command is SIGKILLed by pid. */
let startedPids: number[] = [];

/**
 * True for a live process; a zombie counts as dead. Read-only (`ps`) — never
 * signals anything.
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
 * while it is alive AND still runs a fixture command — a `sleep`, or a shell running
 * a script from this test's temp dir. A pid recycled by anything else is left alone.
 */
function killIfFixture(pid: number): void {
  if (!isAlive(pid)) return;
  const cmd = commandOf(pid);
  if (cmd === null) return;
  const exe = path.basename(cmd.split(/\s+/)[0] ?? "");
  const ours = /^(\S*\/)?sleep \d+$/.test(cmd) || ((exe === "sh" || exe === "bash") && cmd.includes(dir));
  if (!ours) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* exited between the check and the signal */
  }
}

/** Reads a pid a fixture wrote and remembers it for cleanup. */
function trackPid(file: string): number {
  const pid = Number(fs.readFileSync(file, "utf8").trim());
  expect(pid).toBeGreaterThan(0);
  startedPids.push(pid);
  return pid;
}

function bin(name: string, body: string, sub = "bin"): string {
  const d = path.join(dir, sub);
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "libi-cli-resolve-")));
  invalidateAgentCliMemo();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  // Also every pid a fixture wrote, even when the test failed before reading it.
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".pid")) : []) {
    const pid = Number(fs.readFileSync(path.join(dir, f), "utf8").trim());
    if (pid > 0 && !startedPids.includes(pid)) startedPids.push(pid);
  }
  for (const pid of startedPids) killIfFixture(pid);
  startedPids = [];
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.LIBI_TEST_AGENT_CLI_DIRS;
  delete process.env.LIBI_ENABLE_TEST_ROUTES;
});

const posix = { platform: "darwin" as const, libiRoots: ["/nowhere/libi"], minimum: MIN };

describe.skipIf(process.platform === "win32")("resolveAgentCli — posix, real fixture binaries", () => {
  it("found: path, realpath, version, meetsMinimum", async () => {
    const file = bin("claude", 'echo "2.1.250 (Claude Code)"');
    const r = await resolveAgentCli("claude-code", { ...posix, searchDirs: async () => [path.dirname(file)] });
    expect(r).toEqual({ path: file, realPath: file, execPath: file, version: "2.1.250", meetsMinimum: true });
    expect(isUsableCli(r)).toBe(true);
  });

  it("not found → null", async () => {
    expect(await resolveAgentCli("codex", { ...posix, searchDirs: async () => [dir] })).toBeNull();
  });

  it("a hit inside libi's own tree is rejected (libi-internal)", async () => {
    const file = bin("codex", 'echo "codex-cli 0.160.0"');
    const r = await resolveAgentCli("codex", { ...posix, libiRoots: [dir], searchDirs: async () => [path.dirname(file)] });
    expect(r).toBeNull();
  });

  it("symlink / fnm-style shim: realPath is the target, path is the link", async () => {
    const real = bin("claude", 'echo "2.1.245 (Claude Code)"', "real");
    const linkDir = path.join(dir, "fnm_multishells", "123_456", "bin");
    fs.mkdirSync(linkDir, { recursive: true });
    fs.symlinkSync(real, path.join(linkDir, "claude"));
    const r = await resolveAgentCli("claude-code", { ...posix, searchDirs: async () => [linkDir] });
    expect(r && "realPath" in r ? r.realPath : null).toBe(real);
    expect(r && "path" in r ? r.path : null).toBe(path.join(linkDir, "claude"));
  });

  it("below the minimum: found, meetsMinimum false", async () => {
    const file = bin("claude", 'echo "2.0.1 (Claude Code)"');
    const r = await resolveAgentCli("claude-code", { ...posix, searchDirs: async () => [path.dirname(file)] });
    expect(r && "meetsMinimum" in r ? r.meetsMinimum : null).toBe(false);
  });

  it("broken binary (non-zero exit) → foundButBroken with the path", async () => {
    const file = bin("codex", "exit 1");
    expect(await resolveAgentCli("codex", { ...posix, searchDirs: async () => [path.dirname(file)] })).toEqual({
      foundButBroken: true, path: file,
    });
  });

  it("--version output without a semver → foundButBroken", async () => {
    const file = bin("codex", 'echo "nope"');
    expect(await resolveAgentCli("codex", { ...posix, searchDirs: async () => [path.dirname(file)] })).toEqual({
      foundButBroken: true, path: file,
    });
  });

  it("--version that hangs past 3 s → foundButBroken, and the hung process is gone afterwards (by pid)", async () => {
    const pidFile = path.join(dir, "hang.pid");
    // `exec`: the sleep IS the process that was spawned, so no orphan can outlive the test.
    const file = bin("claude", `echo $$ > "${pidFile}"\nexec sleep 6`);
    const warn = vi.spyOn(serverLogger, "warn");
    const started = Date.now();
    const r = await resolveAgentCli("claude-code", { ...posix, searchDirs: async () => [path.dirname(file)] });
    expect(r).toEqual({ foundButBroken: true, path: file });
    expect(Date.now() - started).toBeLessThan(VERSION_BOUND_MS + 500);
    const pid = trackPid(pidFile);
    await vi.waitFor(() => expect(isAlive(pid), "the hung --version").toBe(false), { timeout: KILL_BUDGET_MS + 1_000, interval: 50 });
    // The kill is logged once it is over, counts only: no path, no command, no error text.
    await vi.waitFor(
      () =>
        expect(warn).toHaveBeenCalledWith(
          { tag: "agent-cli", op: "version_check_timeout", killed: 1, notExitedAfterKill: 0 },
          expect.any(String),
        ),
      { timeout: KILL_BUDGET_MS + 1_000, interval: 50 },
    );
    const fields = warn.mock.calls.map(([f]) => f as unknown as Record<string, unknown>).find((f) => f.op === "version_check_timeout")!;
    for (const [k, v] of Object.entries(fields)) expect(typeof v, k).toBe(k === "tag" || k === "op" ? "string" : "number");
  }, 10_000);

  it("a --version that prints its version and exits 0 while a SIGTERM-proof background child holds stdout is an answer at once; the child is ended with its group (by pid)", async () => {
    const bgPidFile = path.join(dir, "bg.pid");
    const file = bin(
      "claude",
      [
        'echo "2.1.250 (Claude Code)"',
        `trap "" TERM`, // inherited: only the group SIGKILL ends the child
        "sleep 30 &", // inherits stdout, so the pipe stays open after the script exits 0
        `echo $! > "${bgPidFile}"`,
      ].join("\n"),
    );
    const started = Date.now();
    const r = await resolveAgentCli("claude-code", { ...posix, searchDirs: async () => [path.dirname(file)] });
    expect(r).toEqual({ path: file, realPath: file, execPath: file, version: "2.1.250", meetsMinimum: true });
    expect(Date.now() - started).toBeLessThan(VERSION_BOUND_MS / 2);
    const bgPid = trackPid(bgPidFile);
    await vi.waitFor(() => expect(isAlive(bgPid), "the background child").toBe(false), {
      timeout: KILL_BUDGET_MS + 1_000,
      interval: 50,
    });
  }, 10_000);

  it("the default --version runner bounds itself: one timer at the bound, no second outer timer firing just before it", async () => {
    const file = bin("claude", 'echo "2.1.250 (Claude Code)"');
    const timers = vi.spyOn(globalThis, "setTimeout");
    const r = await resolveAgentCli("claude-code", { ...posix, searchDirs: async () => [path.dirname(file)] });
    expect(isUsableCli(r)).toBe(true);
    expect(timers.mock.calls.filter((call) => call[1] === AGENT_CLI_VERSION_TIMEOUT_MS)).toHaveLength(1);
  });

  it("a --version that ignores SIGTERM and backgrounds a child holding stdout: the caller is released at the bound, the whole group is killed (both pids), and the next caller is not blocked", async () => {
    const shPidFile = path.join(dir, "sh.pid");
    const bgPidFile = path.join(dir, "bg.pid");
    const file = bin(
      "claude",
      [
        `trap "" TERM`, // ignored SIGTERM is inherited by the background child too
        `echo $$ > "${shPidFile}"`,
        "sleep 30 &", // inherits stdout, so the pipe never closes while it lives
        `echo $! > "${bgPidFile}"`,
        "wait",
      ].join("\n"),
    );
    let now = 100_000;
    const deps = { ...posix, searchDirs: async () => [path.dirname(file)], now: () => now };
    const started = Date.now();
    const r = await resolveAgentCli("claude-code", deps);
    const elapsed = Date.now() - started;
    expect(r).toEqual({ foundButBroken: true, path: file });
    expect(elapsed).toBeLessThan(VERSION_BOUND_MS + 500);
    const shPid = trackPid(shPidFile);
    const bgPid = trackPid(bgPidFile);
    await vi.waitFor(
      () => {
        expect(isAlive(shPid), "the --version shell").toBe(false);
        expect(isAlive(bgPid), "its background child").toBe(false);
      },
      { timeout: KILL_BUDGET_MS + 1_000, interval: 50 },
    );
    // The in-flight slot was released at the bound: a later resolution runs afresh and is not joined to the hang.
    now += AGENT_CLI_MEMO_MS + 1;
    const next = await resolveAgentCli("claude-code", { ...deps, spawnVersion: async () => ({ ok: true, stdout: "2.1.250 (Claude Code)" }) });
    expect(isUsableCli(next)).toBe(true);
  }, 15_000);

  it("searches the login-shell PATH first, then the process PATH, then the known folders", async () => {
    const login = bin("claude", 'echo "2.1.246 (Claude Code)"', "login");
    const proc = bin("claude", 'echo "2.1.247 (Claude Code)"', "proc");
    const known = bin("claude", 'echo "2.1.248 (Claude Code)"', "known");
    const base = { ...posix, processPathDirs: () => [path.dirname(proc)], knownDirs: [path.dirname(known)] };
    const r1 = await resolveAgentCli("claude-code", { ...base, loginShellPathDirs: async () => [path.dirname(login)] });
    expect(r1 && "version" in r1 ? r1.version : null).toBe("2.1.246");
    invalidateAgentCliMemo();
    const r2 = await resolveAgentCli("claude-code", { ...base, loginShellPathDirs: async () => [] });
    expect(r2 && "version" in r2 ? r2.version : null).toBe("2.1.247");
    invalidateAgentCliMemo();
    const r3 = await resolveAgentCli("claude-code", { ...base, loginShellPathDirs: async () => [], processPathDirs: () => [] });
    expect(r3 && "version" in r3 ? r3.version : null).toBe("2.1.248");
  });
});

describe("resolveAgentCli — memo", () => {
  it.skipIf(process.platform === "win32")("serves the memo for 30 s, re-resolves after it, and drops it on invalidate or an mtime change", async () => {
    const file = bin("claude", 'echo "2.1.245 (Claude Code)"');
    const spawnVersion = vi.fn(async () => ({ ok: true, stdout: "2.1.245 (Claude Code)" }));
    let now = 100_000;
    let mtime = 1;
    const deps = { ...posix, searchDirs: async () => [path.dirname(file)], spawnVersion, now: () => now, mtimeOf: () => mtime };
    await resolveAgentCli("claude-code", deps);
    now += AGENT_CLI_MEMO_MS - 1;
    await resolveAgentCli("claude-code", deps);
    expect(spawnVersion).toHaveBeenCalledTimes(1);
    now += 2;
    await resolveAgentCli("claude-code", deps);
    expect(spawnVersion).toHaveBeenCalledTimes(2);
    invalidateAgentCliMemo("claude-code");
    await resolveAgentCli("claude-code", deps);
    expect(spawnVersion).toHaveBeenCalledTimes(3);
    mtime = 2;
    await resolveAgentCli("claude-code", deps);
    expect(spawnVersion).toHaveBeenCalledTimes(4);
  });

  it.skipIf(process.platform === "win32")("never memoizes a null — a CLI installed mid-wizard shows on the very next poll", async () => {
    const loginShellPathDirs = vi.fn(async () => [path.join(dir, "bin")]);
    const deps = { ...posix, loginShellPathDirs, processPathDirs: () => [] as string[], knownDirs: [] as string[], now: () => 5 };
    expect(await resolveAgentCli("codex", deps)).toBeNull();
    bin("codex", 'echo "codex-cli 0.160.0"'); // the installer finished between two polls
    const r = await resolveAgentCli("codex", deps);
    expect(r && "version" in r ? r.version : null).toBe("0.160.0");
    expect(loginShellPathDirs).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform === "win32")("staleOk: an expired memo is served at once and refreshed in the background", async () => {
    const file = bin("claude", 'echo "2.1.245 (Claude Code)"');
    let stdout = "2.1.245 (Claude Code)";
    const spawnVersion = vi.fn(async () => ({ ok: true, stdout }));
    let now = 100_000;
    const deps = { ...posix, searchDirs: async () => [path.dirname(file)], spawnVersion, now: () => now, mtimeOf: () => 1 };
    await resolveAgentCli("claude-code", deps);
    now += AGENT_CLI_MEMO_MS + 1; // expired
    stdout = "2.1.300 (Claude Code)";
    let releaseSearch!: () => void;
    const gate = new Promise<void>((r) => (releaseSearch = r));
    const slow = { ...deps, searchDirs: async () => { await gate; return [path.dirname(file)]; }, staleOk: true };
    const served = await resolveAgentCli("claude-code", slow); // must not wait on the gated search
    expect(served && "version" in served ? served.version : null).toBe("2.1.245");
    releaseSearch();
    await vi.waitFor(() => expect(spawnVersion).toHaveBeenCalledTimes(2));
    const fresh = await resolveAgentCli("claude-code", { ...deps, staleOk: true });
    expect(fresh && "version" in fresh ? fresh.version : null).toBe("2.1.300");
  });

  it.skipIf(process.platform === "win32")("an invalidate during an in-flight resolution keeps that result out of the memo (the caller still gets it)", async () => {
    const file = bin("claude", 'echo "2.1.245 (Claude Code)"');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spawnVersion = vi.fn(async () => {
      await gate;
      return { ok: true, stdout: "2.1.245 (Claude Code)" };
    });
    const deps = { ...posix, searchDirs: async () => [path.dirname(file)], spawnVersion, now: () => 5, mtimeOf: () => 1 };
    const first = resolveAgentCli("claude-code", deps);
    await vi.waitFor(() => expect(spawnVersion).toHaveBeenCalledTimes(1));
    invalidateAgentCliMemo("claude-code");
    release();
    expect(isUsableCli(await first)).toBe(true);
    await resolveAgentCli("claude-code", deps);
    expect(spawnVersion).toHaveBeenCalledTimes(2); // nothing was memoized by the invalidated run
  });

  it.skipIf(process.platform === "win32")("invalidating one agent does not discard the other agent's in-flight result", async () => {
    const file = bin("codex", 'echo "codex-cli 0.160.0"');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spawnVersion = vi.fn(async () => {
      await gate;
      return { ok: true, stdout: "codex-cli 0.160.0" };
    });
    const deps = { ...posix, searchDirs: async () => [path.dirname(file)], spawnVersion, now: () => 5, mtimeOf: () => 1 };
    const first = resolveAgentCli("codex", deps);
    await vi.waitFor(() => expect(spawnVersion).toHaveBeenCalledTimes(1));
    invalidateAgentCliMemo("claude-code");
    release();
    expect(isUsableCli(await first)).toBe(true);
    const again = await resolveAgentCli("codex", deps);
    expect(isUsableCli(again)).toBe(true);
    expect(spawnVersion).toHaveBeenCalledTimes(1); // codex's result was memoized despite the claude-code invalidate
  });

  it.skipIf(process.platform === "win32")("a found memo is dropped when a later resolution finds nothing", async () => {
    const file = bin("claude", 'echo "2.1.245 (Claude Code)"');
    const spawnVersion = vi.fn(async () => ({ ok: true, stdout: "2.1.245 (Claude Code)" }));
    let mtime = 1;
    let dirs = [path.dirname(file)];
    const deps = { ...posix, searchDirs: async () => dirs, spawnVersion, now: () => 5, mtimeOf: () => mtime };
    expect(isUsableCli(await resolveAgentCli("claude-code", deps))).toBe(true);
    mtime = 2; // the memo no longer matches the file → re-resolve
    dirs = [];
    expect(await resolveAgentCli("claude-code", deps)).toBeNull();
    // Were the old memo still there, this mtime would make it fresh again and nothing would spawn.
    mtime = 1;
    dirs = [path.dirname(file)];
    expect(isUsableCli(await resolveAgentCli("claude-code", deps))).toBe(true);
    expect(spawnVersion).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform === "win32")("staleOk: a background refresh that fails is logged (agent only, no error text) and never thrown", async () => {
    const warn = vi.spyOn(serverLogger, "warn");
    const file = bin("claude", 'echo "2.1.245 (Claude Code)"');
    let now = 100_000;
    const deps = { ...posix, searchDirs: async () => [path.dirname(file)], now: () => now, mtimeOf: () => 1 };
    await resolveAgentCli("claude-code", deps);
    now += AGENT_CLI_MEMO_MS + 1;
    const failing = { ...deps, staleOk: true, searchDirs: async (): Promise<string[]> => { throw new Error("boom at /private/secret/path"); } };
    const served = await resolveAgentCli("claude-code", failing);
    expect(served && "version" in served ? served.version : null).toBe("2.1.245");
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith({ tag: "agent-cli", op: "background_refresh_failed", agentId: "claude-code" }, expect.any(String)),
    );
  });

  it.skipIf(process.platform === "win32")("logs a not-found resolution at debug and a found one at info", async () => {
    const info = vi.spyOn(serverLogger, "info");
    const debug = vi.spyOn(serverLogger, "debug");
    expect(await resolveAgentCli("codex", { ...posix, searchDirs: async () => [dir] })).toBeNull();
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({ tag: "agent-cli", op: "resolve", agentId: "codex", found: "none" }), expect.any(String));
    expect(info).not.toHaveBeenCalledWith(expect.objectContaining({ op: "resolve" }), expect.anything());
    const file = bin("claude", 'echo "2.1.250 (Claude Code)"');
    await resolveAgentCli("claude-code", { ...posix, searchDirs: async () => [path.dirname(file)] });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ tag: "agent-cli", op: "resolve", agentId: "claude-code", found: "user" }), expect.any(String));
  });

  it.skipIf(process.platform === "win32")("staleOk: a memo whose binary has since vanished is cold — resolved afresh, never served", async () => {
    const file = bin("claude", 'echo "2.1.245 (Claude Code)"');
    const spawnVersion = vi.fn(async () => ({ ok: true, stdout: "2.1.245 (Claude Code)" }));
    const deps = { ...posix, searchDirs: async () => [path.dirname(file)], spawnVersion, now: () => 5, mtimeOf: () => 1 };
    expect(isUsableCli(await resolveAgentCli("claude-code", deps))).toBe(true);
    fs.rmSync(file);
    // mtime lookup fails (the file is gone), and the fresh search finds nothing.
    const gone = { ...deps, staleOk: true, mtimeOf: () => null };
    expect(await resolveAgentCli("claude-code", gone)).toBeNull();
    expect(spawnVersion).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === "win32")("a memo written while the stat failed (mtime null) is never fresh: a vanished binary is resolved afresh, not served", async () => {
    const file = bin("claude", 'echo "2.1.245 (Claude Code)"');
    const spawnVersion = vi.fn(async () => ({ ok: true, stdout: "2.1.245 (Claude Code)" }));
    // The stat fails right after --version, so the memo records no mtime; every later stat fails too.
    const deps = { ...posix, searchDirs: async () => [path.dirname(file)], spawnVersion, now: () => 5, mtimeOf: () => null };
    expect(isUsableCli(await resolveAgentCli("claude-code", deps))).toBe(true);
    fs.rmSync(file);
    // Inside the memo window: null === null must not read as "unchanged", with or without staleOk.
    expect(await resolveAgentCli("claude-code", deps)).toBeNull();
    bin("claude", 'echo "2.1.245 (Claude Code)"');
    expect(isUsableCli(await resolveAgentCli("claude-code", deps))).toBe(true);
    fs.rmSync(file);
    expect(await resolveAgentCli("claude-code", { ...deps, staleOk: true })).toBeNull();
    expect(spawnVersion).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform === "win32")("staleOk: an expired memo that says below the minimum is never served — resolved afresh, so a CLI updated in place is not refused", async () => {
    const file = bin("claude", 'echo "2.0.1 (Claude Code)"');
    let stdout = "2.0.1 (Claude Code)";
    const spawnVersion = vi.fn(async () => ({ ok: true, stdout }));
    let now = 100_000;
    const deps = { ...posix, searchDirs: async () => [path.dirname(file)], spawnVersion, now: () => now, mtimeOf: () => 1 };
    expect(isUsableCli(await resolveAgentCli("claude-code", deps))).toBe(false);
    now += AGENT_CLI_MEMO_MS + 1;
    stdout = "2.1.300 (Claude Code)"; // updated in place: same realPath
    const r = await resolveAgentCli("claude-code", { ...deps, staleOk: true });
    expect(r && "version" in r ? r.version : null).toBe("2.1.300");
    expect(isUsableCli(r)).toBe(true);
    expect(spawnVersion).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform === "win32")("staleOk: an expired broken memo is never served either", async () => {
    const file = bin("codex", 'echo "codex-cli 0.160.0"');
    let res = { ok: false, stdout: "" };
    const spawnVersion = vi.fn(async () => res);
    let now = 100_000;
    const deps = { ...posix, searchDirs: async () => [path.dirname(file)], spawnVersion, now: () => now, mtimeOf: () => 1 };
    const broken = await resolveAgentCli("codex", deps);
    expect(broken !== null && "foundButBroken" in broken).toBe(true);
    now += AGENT_CLI_MEMO_MS + 1;
    res = { ok: true, stdout: "codex-cli 0.160.0" };
    expect(isUsableCli(await resolveAgentCli("codex", { ...deps, staleOk: true }))).toBe(true);
    expect(spawnVersion).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform === "win32")("a PATH link repointed at a new version is no longer fresh, although the old target is still there with its mtime", async () => {
    const v1 = bin("claude", 'echo "2.1.245 (Claude Code)"', path.join("versions", "2.1.245"));
    const v2 = bin("claude", 'echo "2.1.300 (Claude Code)"', path.join("versions", "2.1.300"));
    const linkDir = path.join(dir, "local-bin");
    fs.mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, "claude");
    fs.symlinkSync(v1, link);
    let stdout = "2.1.245 (Claude Code)";
    const spawnVersion = vi.fn(async () => ({ ok: true, stdout }));
    const deps = { ...posix, searchDirs: async () => [linkDir], spawnVersion, now: () => 5, mtimeOf: (p: string) => (p === v1 ? 1 : 2) };
    const first = await resolveAgentCli("claude-code", deps);
    expect(first && "realPath" in first ? first.realPath : null).toBe(v1);
    await resolveAgentCli("claude-code", deps);
    expect(spawnVersion).toHaveBeenCalledTimes(1); // the unchanged link is fresh

    // The updater repoints the link and leaves the old version in place.
    fs.rmSync(link);
    fs.symlinkSync(v2, link);
    stdout = "2.1.300 (Claude Code)";
    const r = await resolveAgentCli("claude-code", deps);
    expect(r && "realPath" in r ? r.realPath : null).toBe(v2);
    expect(r && "version" in r ? r.version : null).toBe("2.1.300");
    expect(spawnVersion).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform === "win32")("staleOk with NO memo resolves normally; concurrent calls share one resolution", async () => {
    const file = bin("claude", 'echo "2.1.245 (Claude Code)"');
    const spawnVersion = vi.fn(async () => ({ ok: true, stdout: "2.1.245 (Claude Code)" }));
    const deps = { ...posix, searchDirs: async () => [path.dirname(file)], spawnVersion, staleOk: true };
    const [a, b] = await Promise.all([resolveAgentCli("claude-code", deps), resolveAgentCli("claude-code", deps)]);
    expect(isUsableCli(a) && isUsableCli(b)).toBe(true);
    expect(spawnVersion).toHaveBeenCalledTimes(1);
  });
});

describe("resolveAgentCli — Windows (injected, host-independent)", () => {
  const win = {
    platform: "win32" as const,
    libiRoots: ["C:\\libi"],
    minimum: MIN,
    realpath: (p: string) => p,
    mtimeOf: () => 1,
  };

  it("prefers a native .exe over a .cmd shim", async () => {
    const r = await resolveAgentCli("claude-code", {
      ...win,
      searchDirs: async () => ["C:\\Users\\me\\.local\\bin"],
      isExecutable: (p) => p.endsWith("claude.exe") || p.endsWith("claude.cmd"),
      spawnVersion: async () => ({ ok: true, stdout: "2.1.250 (Claude Code)" }),
    });
    expect(r && "path" in r ? r.path : null).toBe("C:\\Users\\me\\.local\\bin\\claude.exe");
    expect(r && "execPath" in r ? r.execPath : null).toBe("C:\\Users\\me\\.local\\bin\\claude.exe");
  });

  it("prefers a native .exe ACROSS the whole search order: .cmd in an earlier folder, .exe in a later one → .exe", async () => {
    const r = await resolveAgentCli("claude-code", {
      ...win,
      searchDirs: async () => ["C:\\Users\\me\\AppData\\Roaming\\npm", "C:\\Users\\me\\.local\\bin"],
      isExecutable: (p) => p === "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd" || p === "C:\\Users\\me\\.local\\bin\\claude.exe",
      readFile: () => '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js"',
      spawnVersion: async () => ({ ok: true, stdout: "2.1.250 (Claude Code)" }),
    });
    expect(r && "path" in r ? r.path : null).toBe("C:\\Users\\me\\.local\\bin\\claude.exe");
  });

  it("an npm .cmd Claude is handed to the adapter as its JS target, and --version runs through node", async () => {
    const shim = '@ECHO off\r\n"%_prog%"  "%dp0%\\..\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
    const spawnVersion = vi.fn<(spawn: { command: string; args: string[] }) => Promise<{ ok: boolean; stdout: string }>>(async () => ({ ok: true, stdout: "2.1.250 (Claude Code)" }));
    const r = await resolveAgentCli("claude-code", {
      ...win,
      searchDirs: async () => ["C:\\npm"],
      isExecutable: (p) => p.endsWith("claude.cmd"),
      readFile: () => shim,
      spawnVersion,
    });
    expect(r && "execPath" in r ? r.execPath : null).toMatch(/cli\.js$/);
    expect(r && "execPath" in r ? r.execPath : null).not.toBe("C:\\npm\\claude.cmd");
    expect(spawnVersion.mock.calls[0][0].args.at(-1)).toBe("--version");
    expect(spawnVersion.mock.calls[0][0].args.at(-2)).toMatch(/cli\.js$/);
  });

  it("an npm .cmd Claude whose shim runs a NATIVE bin\\claude.exe (claude-code 2.1.267, no cli.js) is handed that .exe, and --version runs it directly", async () => {
    // The target line npm's cmd-shim writes into %APPDATA%\npm\claude.cmd for claude-code 2.1.267 on Windows.
    const shim = String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
`;
    const spawnVersion = vi.fn<(spawn: { command: string; args: string[] }) => Promise<{ ok: boolean; stdout: string }>>(async () => ({ ok: true, stdout: "2.1.267 (Claude Code)" }));
    const r = await resolveAgentCli("claude-code", {
      ...win,
      searchDirs: async () => ["C:\\Users\\me\\AppData\\Roaming\\npm"],
      isExecutable: (p) => p === "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
      readFile: () => shim,
      spawnVersion,
    });
    const target = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
    expect(r && "realPath" in r ? r.realPath : null).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd");
    expect(r && "execPath" in r ? r.execPath : null).toBe(target);
    // Spawning the .cmd itself fails with EINVAL, so --version runs the target too.
    expect(spawnVersion.mock.calls[0][0]).toEqual({ command: target, args: ["--version"] });
  });

  it("resolveCmdShimNativeTarget reads only a real .exe target (never the shim's own node.exe probe), with Windows path rules on any host", () => {
    expect(
      resolveCmdShimNativeTarget("C:\\npm\\claude.cmd", () => '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*'),
    ).toBe("C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");
    expect(resolveCmdShimNativeTarget("C:\\npm\\codex.cmd", () => '"%dp0%\\..\\@openai\\codex\\bin\\codex.js" %*')).toBeNull();
    expect(resolveCmdShimNativeTarget("C:\\npm\\x.cmd", () => 'IF EXIST "%dp0%\\node.exe" (')).toBeNull();
    expect(resolveCmdShimNativeTarget("C:\\npm\\gone.cmd", () => { throw new Error("ENOENT"); })).toBeNull();
  });

  it("a .cmd Codex keeps the .cmd as execPath (codex-acp spawns with shell:true on win32)", async () => {
    const r = await resolveAgentCli("codex", {
      ...win,
      searchDirs: async () => ["C:\\npm"],
      isExecutable: (p) => p.endsWith("codex.cmd"),
      readFile: () => '"%dp0%\\..\\@openai\\codex\\bin\\codex.js"',
      spawnVersion: async () => ({ ok: true, stdout: "codex-cli 0.160.0" }),
    });
    expect(r && "execPath" in r ? r.execPath : null).toBe("C:\\npm\\codex.cmd");
  });
});

describe("resolveAgentCli — the --version check never outlives its bound (injected, host-independent)", () => {
  const win = {
    platform: "win32" as const,
    libiRoots: ["C:\\libi"],
    minimum: MIN,
    realpath: (p: string) => p,
    mtimeOf: () => 1,
    searchDirs: async () => ["C:\\bin"],
    isExecutable: (p: string) => p === "C:\\bin\\claude.exe",
  };
  const EXE = "C:\\bin\\claude.exe";

  it("a spawnVersion that never settles resolves foundButBroken AT the bound for every caller, and the next resolution is not joined to it", async () => {
    vi.useFakeTimers();
    let now = 100_000;
    const hung = vi.fn(() => new Promise<{ ok: boolean; stdout: string }>(() => undefined));
    const deps = { ...win, now: () => now, spawnVersion: hung };
    let settled = false;
    const first = resolveAgentCli("claude-code", deps).finally(() => {
      settled = true;
    });
    const joined = resolveAgentCli("claude-code", deps); // a concurrent caller shares the same bound
    await vi.advanceTimersByTimeAsync(VERSION_BOUND_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await first).toEqual({ foundButBroken: true, path: EXE });
    expect(await joined).toEqual({ foundButBroken: true, path: EXE });
    now += AGENT_CLI_MEMO_MS + 1;
    const next = await resolveAgentCli("claude-code", { ...deps, spawnVersion: async () => ({ ok: true, stdout: "2.1.250 (Claude Code)" }) });
    expect(isUsableCli(next)).toBe(true);
    expect(hung).toHaveBeenCalledTimes(1);
  });

  it("a spawnVersion that throws synchronously → foundButBroken, never a rejection", async () => {
    const r = await resolveAgentCli("claude-code", {
      ...win,
      spawnVersion: () => {
        throw new Error("spawn EINVAL");
      },
    });
    expect(r).toEqual({ foundButBroken: true, path: EXE });
  });

  it("runCliVersion: a spawn that throws synchronously → { ok: false }", async () => {
    const throwing = (() => {
      throw new Error("spawn EINVAL");
    }) as unknown as typeof nodeSpawn;
    await expect(runCliVersion({ command: EXE, args: ["--version"] }, { spawn: throwing, platform: "win32" })).resolves.toEqual({ ok: false, stdout: "" });
  });

  it("an injected runner keeps the outer bound: one timer at the bound for it", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const r = await resolveAgentCli("claude-code", { ...win, spawnVersion: async () => ({ ok: true, stdout: "2.1.250 (Claude Code)" }) });
    expect(isUsableCli(r)).toBe(true);
    expect(timers.mock.calls.filter((call) => call[1] === AGENT_CLI_VERSION_TIMEOUT_MS)).toHaveLength(1);
  });
});

/** A `--version` child that never emits `close` unless a test says so. */
class FakeVersionChild extends EventEmitter {
  stdout = new EventEmitter();
  kill = vi.fn();
  constructor(public pid: number) {
    super();
  }
}

const esrch = (): never => {
  throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
};

describe("runCliVersion — a clean exit 0 with a version is an answer, even while stdout stays open (fake child)", () => {
  const CMD = { command: "/fake/bin/claude", args: ["--version"] };
  const spawnOf = (child: FakeVersionChild) => (() => child) as unknown as typeof nodeSpawn;

  it("version on stdout, then exit 0, no close: answered with no timer advanced; the group is SIGTERMed, SIGKILLed after the grace, re-checked, and the end logged at debug", async () => {
    vi.useFakeTimers();
    const child = new FakeVersionChild(900_201);
    // A member is there for SIGTERM and SIGKILL; after that the group is empty.
    const kill = vi.spyOn(process, "kill").mockImplementation(((_pid: number, sig?: string | number) => (sig === 0 ? esrch() : true)) as typeof process.kill);
    const debug = vi.spyOn(serverLogger, "debug");
    const warn = vi.spyOn(serverLogger, "warn");
    let got: unknown = null;
    void runCliVersion(CMD, { spawn: spawnOf(child), platform: "darwin" }).then((r) => {
      got = r;
    });
    child.stdout.emit("data", Buffer.from("2.1.250 (Claude Code)\n"));
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual({ ok: true, stdout: "2.1.250 (Claude Code)\n" });
    expect(kill.mock.calls).toEqual([[-900_201, "SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(GROUP_KILL_GRACE_MS);
    expect(kill.mock.calls).toEqual([[-900_201, "SIGTERM"], [-900_201, "SIGKILL"], [-900_201, 0]]);
    expect(debug).toHaveBeenCalledWith(
      { tag: "agent-cli", op: "version_check_group_ended", killed: 1, notExitedAfterKill: 0 },
      expect.any(String),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("exit 0 first, the version after it split across two chunks: answered once the line is complete, never from half a version", async () => {
    vi.useFakeTimers();
    const child = new FakeVersionChild(900_202);
    vi.spyOn(process, "kill").mockImplementation(esrch as unknown as typeof process.kill);
    let got: unknown = null;
    void runCliVersion(CMD, { spawn: spawnOf(child), platform: "darwin" }).then((r) => {
      got = r;
    });
    child.emit("exit", 0, null);
    child.stdout.emit("data", Buffer.from("2.1.2"));
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toBeNull();
    child.stdout.emit("data", Buffer.from("50 (Claude Code)\n"));
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual({ ok: true, stdout: "2.1.250 (Claude Code)\n" });
  });

  it("exit 0 with no version, and a version with a non-zero exit, both keep waiting for close — and time out without one", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockImplementation(esrch as unknown as typeof process.kill);
    const silent = new FakeVersionChild(900_203);
    const failing = new FakeVersionChild(900_204);
    let silentGot: unknown = null;
    let failingGot: unknown = null;
    void runCliVersion(CMD, { spawn: spawnOf(silent), platform: "darwin" }).then((r) => {
      silentGot = r;
    });
    void runCliVersion(CMD, { spawn: spawnOf(failing), platform: "darwin" }).then((r) => {
      failingGot = r;
    });
    silent.stdout.emit("data", Buffer.from("no version here\n"));
    silent.emit("exit", 0, null);
    failing.stdout.emit("data", Buffer.from("2.1.250 (Claude Code)\n"));
    failing.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(AGENT_CLI_VERSION_TIMEOUT_MS - 1);
    expect(silentGot).toBeNull();
    expect(failingGot).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(silentGot).toEqual({ ok: false, stdout: "" });
    expect(failingGot).toEqual({ ok: false, stdout: "" });
  });
});

describe("resolve.ts is a light leaf: nothing it imports reaches the Codex config module", () => {
  /** Every runtime module reachable from `entry` through `@/…` and relative imports (type-only imports skipped). */
  function importClosure(entry: string): string[] {
    const root = process.cwd();
    const fileFor = (p: string): string | null =>
      [p, `${p}.ts`, `${p}.tsx`, path.join(p, "index.ts")].find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
    const seen = new Set<string>();
    const queue = [path.join(root, entry)];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const m of fs.readFileSync(file, "utf8").matchAll(/^\s*(import|export)\s+(type\s)?[^;]*?from\s+["']([^"']+)["']/gm)) {
        if (m[2]) continue;
        const spec = m[3];
        const target = spec.startsWith("@/") ? fileFor(path.join(root, spec.slice(2))) : spec.startsWith(".") ? fileFor(path.resolve(path.dirname(file), spec)) : null;
        if (target) queue.push(target);
      }
    }
    return [...seen].map((f) => path.relative(root, f));
  }

  it("no module under lib/codex-config/ is in resolve.ts's import closure", () => {
    const closure = importClosure("lib/agents/cli/resolve.ts");
    expect(closure).toContain("lib/agents/user-cli.ts"); // the walk really follows imports
    expect(closure.filter((f) => f.startsWith("lib/codex-config/"))).toEqual([]);
  });
});

describe("knownInstallDirs", () => {
  it("posix: ~/.local/bin, Homebrew, /usr/local/bin, and the Codex app bundles for codex", () => {
    const claude = knownInstallDirs("claude-code", "darwin", "/Users/me");
    expect(claude).toEqual(["/Users/me/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]);
    const codex = knownInstallDirs("codex", "darwin", "/Users/me");
    expect(codex).toEqual([
      "/Users/me/.local/bin", "/opt/homebrew/bin", "/usr/local/bin",
      "/Applications/ChatGPT.app/Contents/Resources", "/Applications/Codex.app/Contents/Resources",
      "/Users/me/Applications/ChatGPT.app/Contents/Resources", "/Users/me/Applications/Codex.app/Contents/Resources",
    ]);
    expect(knownInstallDirs("codex", "linux", "/home/me")).toEqual(["/home/me/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]);
    // The app-bundle folders are exactly `codexAppBundleDirs`'s, not a second copy of the list.
    expect(codex.slice(3)).toEqual(codexAppBundleDirs("darwin", "/Users/me"));
  });
  it("windows: %USERPROFILE%\\.local\\bin for both, plus the Codex installer folder (expanded from its %VAR% template)", () => {
    const prevLocal = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = "C:\\Users\\me\\AppData\\Local";
    try {
      const dirs = knownInstallDirs("codex", "win32", "C:\\Users\\me");
      expect(dirs[0]).toBe("C:\\Users\\me\\.local\\bin");
      for (const d of dirs) expect(d).not.toMatch(/%[A-Z]+%/); // templates are expanded, never searched literally
      // The official Codex installer puts codex.exe in %LOCALAPPDATA%\Programs\OpenAI\Codex\bin.
      expect(dirs).toEqual(["C:\\Users\\me\\.local\\bin", "C:\\Users\\me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin"]);
      expect(knownInstallDirs("claude-code", "win32", "C:\\Users\\me")).toEqual(["C:\\Users\\me\\.local\\bin"]);
    } finally {
      if (prevLocal === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = prevLocal;
    }
  });
  it("windows: without LOCALAPPDATA the Codex installer folder falls back under the home directory", () => {
    const prevLocal = process.env.LOCALAPPDATA;
    delete process.env.LOCALAPPDATA;
    try {
      expect(knownInstallDirs("codex", "win32", "C:\\Users\\me")).toContain("C:\\Users\\me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin");
    } finally {
      if (prevLocal !== undefined) process.env.LOCALAPPDATA = prevLocal;
    }
  });
});

describe("testAgentCliDirs (e2e hook, LIBI_TEST_AGENT_CLI_DIRS)", () => {
  it("is honoured only under LIBI_ENABLE_TEST_ROUTES=1", () => {
    process.env.LIBI_TEST_AGENT_CLI_DIRS = ["/fake/a", "/fake/b"].join(path.delimiter);
    expect(testAgentCliDirs()).toBeNull();
    process.env.LIBI_ENABLE_TEST_ROUTES = "1";
    expect(testAgentCliDirs()).toEqual(["/fake/a", "/fake/b"]);
  });
  it("reads the gate from the env it is given, not from process.env", () => {
    delete process.env.LIBI_ENABLE_TEST_ROUTES;
    expect(testAgentCliDirs({ NODE_ENV: "test", LIBI_ENABLE_TEST_ROUTES: "1", LIBI_TEST_AGENT_CLI_DIRS: "/fake/a" })).toEqual(["/fake/a"]);
    process.env.LIBI_ENABLE_TEST_ROUTES = "1";
    expect(testAgentCliDirs({ NODE_ENV: "test", LIBI_TEST_AGENT_CLI_DIRS: "/fake/a" })).toBeNull();
  });
  it.skipIf(process.platform === "win32")("replaces the PATH and known-folder steps entirely, never spawning a login shell", async () => {
    const file = bin("claude", 'echo "2.1.245 (Claude Code)"', "fake");
    process.env.LIBI_ENABLE_TEST_ROUTES = "1";
    process.env.LIBI_TEST_AGENT_CLI_DIRS = path.dirname(file);
    const loginShellPathDirs = vi.fn(async () => { throw new Error("must not be called"); });
    const r = await resolveAgentCli("claude-code", { ...posix, loginShellPathDirs, knownDirs: [] });
    expect(r && "path" in r ? r.path : null).toBe(file);
    expect(loginShellPathDirs).not.toHaveBeenCalled();
  });
});
