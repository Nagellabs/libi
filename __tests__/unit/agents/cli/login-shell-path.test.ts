import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));
const logMock = vi.fn();
/** The level each line went out at, with its fields. */
const levelMock = vi.fn();
vi.mock("@/lib/logger", () => ({
  serverLogger: {
    debug: (...a: unknown[]) => {
      levelMock("debug", a[0]);
      logMock(...a);
    },
    info: (...a: unknown[]) => {
      levelMock("info", a[0]);
      logMock(...a);
    },
    warn: (...a: unknown[]) => {
      levelMock("warn", a[0]);
      logMock(...a);
    },
  },
}));

const errno = (code: "ESRCH" | "EPERM"): never => {
  throw Object.assign(new Error(`kill ${code}`), { code });
};

class FakeChild extends EventEmitter {
  /** Undefined unless a test asks for one: the module then falls back to `child.kill`. */
  pid: number | undefined = undefined;
  stdout = Object.assign(new EventEmitter(), { unref: vi.fn() });
  unref = vi.fn();
  kill = vi.fn();
}

/** Log fields are counts only: `tag` + `op` + numbers — never a shell, a path, an error or a value. */
function expectCountsOnlyLogs(): void {
  expect(logMock).toHaveBeenCalled();
  for (const [fields] of logMock.mock.calls) {
    for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
      expect(typeof v, k).toBe(k === "tag" || k === "op" ? "string" : "number");
    }
  }
}

let snapshot: NodeJS.ProcessEnv;
let killSpy: MockInstance<typeof process.kill>;
beforeEach(async () => {
  snapshot = { ...process.env };
  process.env.SHELL = "/bin/zsh";
  spawnMock.mockReset();
  logMock.mockReset();
  levelMock.mockReset();
  // A group signal must never leave the worker.
  killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  const { __clearLoginShellPathMemo } = await import("@/lib/agents/cli/login-shell-path");
  __clearLoginShellPathMemo();
});
afterEach(() => {
  killSpy.mockRestore();
  process.env = snapshot;
});

describe("parsePathProbe", () => {
  it("needs both markers; banner noise around them is ignored", async () => {
    const { parsePathProbe } = await import("@/lib/agents/cli/login-shell-path");
    expect(parsePathProbe("hello\n__LIBI_PATH_START__/a:/b__LIBI_PATH_END__\n")).toEqual(["/a", "/b"]);
    expect(parsePathProbe("__LIBI_PATH_START__/a:/b")).toBeNull();
    expect(parsePathProbe("/a:/b")).toBeNull();
  });
});

describe("loginShellPathDirs", () => {
  it("spawns $SHELL -ilc with the marker-framed PATH echo in its OWN process group and resolves with the framed PATH; the group then gets one SIGTERM, and ESRCH (empty) ends it there", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new FakeChild(), { pid: 900_104 });
      spawnMock.mockReturnValue(child);
      killSpy.mockImplementation((() => errno("ESRCH")) as unknown as typeof process.kill);
      const m = await import("@/lib/agents/cli/login-shell-path");
      const p = m.loginShellPathDirs({ platform: "darwin" });
      expect(spawnMock).toHaveBeenCalledWith(
        "/bin/zsh",
        ["-ilc", 'printf __LIBI_PATH_START__; printf %s "$PATH"; printf __LIBI_PATH_END__'],
        expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"], detached: true }),
      );
      child.stdout.emit("data", Buffer.from("__LIBI_PATH_START__/opt/x/bin:/usr/bin__LIBI_PATH_END__"));
      child.emit("close", 0);
      expect(await p).toEqual(["/opt/x/bin", "/usr/bin"]);
      expect(child.unref).toHaveBeenCalled();
      expect(child.stdout.unref).toHaveBeenCalled();
      // The shell has exited, so the whole group — not the bare pid, not child.kill — is asked once.
      expect(killSpy.mock.calls).toEqual([[-900_104, "SIGTERM"]]);
      // ESRCH is "gone": no SIGKILL follows and nothing is counted or logged as killed.
      await vi.advanceTimersByTimeAsync(m.LOGIN_SHELL_PROBE_KILL_GRACE_MS + m.LOGIN_SHELL_PROBE_EXIT_WAIT_MS);
      expect(killSpy.mock.calls).toEqual([[-900_104, "SIGTERM"]]);
      expect(child.kill).not.toHaveBeenCalled();
      expect(logMock).not.toHaveBeenCalledWith(expect.objectContaining({ op: "login_shell_probe_group_ended" }), expect.anything());
      expectCountsOnlyLogs();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves the moment the complete framed PATH has arrived even if the pipe never closes, then ends its process group", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new FakeChild(), { pid: 900_103 });
      spawnMock.mockReturnValue(child);
      const m = await import("@/lib/agents/cli/login-shell-path");
      let got: string[] | null = null;
      void m.loginShellPathDirs({ platform: "darwin" }).then((d) => {
        got = d;
      });
      // A profile's background job inherited stdout: `close` never comes. The frame may arrive split.
      child.stdout.emit("data", Buffer.from("banner\n__LIBI_PATH_START__/opt/y/bin:/bin__LIBI_PA"));
      child.stdout.emit("data", Buffer.from("TH_END__"));
      await vi.advanceTimersByTimeAsync(0); // no timer has fired
      expect(got).toEqual(["/opt/y/bin", "/bin"]);
      expect(killSpy).not.toHaveBeenCalled(); // the shell first gets a chance to exit on its own
      await vi.advanceTimersByTimeAsync(m.LOGIN_SHELL_PROBE_EXIT_CHANCE_MS);
      expect(killSpy.mock.calls).toEqual([[-900_103, "SIGTERM"]]);
      await vi.advanceTimersByTimeAsync(m.LOGIN_SHELL_PROBE_KILL_GRACE_MS);
      expect(killSpy.mock.calls).toEqual([[-900_103, "SIGTERM"], [-900_103, "SIGKILL"]]);
      await vi.advanceTimersByTimeAsync(m.LOGIN_SHELL_PROBE_EXIT_WAIT_MS);
      expect(logMock).toHaveBeenCalledWith(
        { tag: "agent-cli", op: "login_shell_probe_group_ended", killed: 1, notExitedAfterKill: 1 },
        expect.any(String),
      );
      expect(logMock).not.toHaveBeenCalledWith(expect.objectContaining({ op: "login_shell_probe_timeout" }), expect.anything());
      expectCountsOnlyLogs();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a shell that closes without both markers → []", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const { loginShellPathDirs } = await import("@/lib/agents/cli/login-shell-path");
    const p = loginShellPathDirs({ platform: "darwin" });
    child.stdout.emit("data", Buffer.from("__LIBI_PATH_START__/half/bin"));
    child.emit("exit", 0);
    child.emit("close", 0);
    expect(await p).toEqual([]);
    expect(logMock).toHaveBeenCalledWith({ tag: "agent-cli", op: "login_shell_probe_incomplete", dirs: 0 }, expect.any(String));
    expect(logMock).not.toHaveBeenCalledWith(expect.objectContaining({ op: "login_shell_probe_done" }), expect.anything());
    expectCountsOnlyLogs();
  });

  it("after the answer, a group member SIGKILL ended (EPERM while it is reaped, then ESRCH) is not a survivor: the group end is logged at debug, never warn", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new FakeChild(), { pid: 900_105 });
      spawnMock.mockReturnValue(child);
      let checks = 0;
      killSpy.mockImplementation(((_pid: number, sig?: string | number) => {
        if (sig !== 0) return true; // a member is there for SIGTERM and SIGKILL
        checks += 1;
        return checks === 1 ? errno("EPERM") : errno("ESRCH");
      }) as typeof process.kill);
      const m = await import("@/lib/agents/cli/login-shell-path");
      const p = m.loginShellPathDirs({ platform: "darwin" });
      child.stdout.emit("data", Buffer.from("__LIBI_PATH_START__/opt/z/bin__LIBI_PATH_END__"));
      child.emit("exit", 0); // the shell exits; its background job still holds stdout, so no close
      expect(await p).toEqual(["/opt/z/bin"]);
      await vi.advanceTimersByTimeAsync(m.LOGIN_SHELL_PROBE_KILL_GRACE_MS + 50);
      expect(killSpy.mock.calls).toEqual([[-900_105, "SIGTERM"], [-900_105, "SIGKILL"], [-900_105, 0], [-900_105, 0]]);
      expect(levelMock).toHaveBeenCalledWith("debug", { tag: "agent-cli", op: "login_shell_probe_group_ended", killed: 1, notExitedAfterKill: 0 });
      expect(levelMock).not.toHaveBeenCalledWith("warn", expect.anything());
      expectCountsOnlyLogs();
    } finally {
      vi.useRealTimers();
    }
  });

  it("after the answer, a group member still there when the exit wait is up is counted and warned about — and the wait never runs past its budget", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new FakeChild(), { pid: 900_106 });
      spawnMock.mockReturnValue(child); // signal 0 keeps succeeding: the member never goes
      const m = await import("@/lib/agents/cli/login-shell-path");
      const p = m.loginShellPathDirs({ platform: "darwin" });
      child.stdout.emit("data", Buffer.from("__LIBI_PATH_START__/opt/z/bin__LIBI_PATH_END__"));
      child.emit("exit", 0);
      expect(await p).toEqual(["/opt/z/bin"]);
      await vi.advanceTimersByTimeAsync(m.LOGIN_SHELL_PROBE_KILL_GRACE_MS + m.LOGIN_SHELL_PROBE_EXIT_WAIT_MS - 1);
      expect(logMock).not.toHaveBeenCalledWith(expect.objectContaining({ op: "login_shell_probe_group_ended" }), expect.anything());
      await vi.advanceTimersByTimeAsync(1);
      expect(levelMock).toHaveBeenCalledWith("warn", { tag: "agent-cli", op: "login_shell_probe_group_ended", killed: 1, notExitedAfterKill: 1 });
      expect(levelMock).not.toHaveBeenCalledWith("debug", expect.objectContaining({ op: "login_shell_probe_group_ended" }));
      const polls = killSpy.mock.calls.filter(([, sig]) => sig === 0).length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(killSpy.mock.calls.filter(([, sig]) => sig === 0).length).toBe(polls); // nothing keeps polling past the budget
      expectCountsOnlyLogs();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a spawn that throws synchronously → [] and a counts-only warning", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("spawn EACCES");
    });
    const { loginShellPathDirs } = await import("@/lib/agents/cli/login-shell-path");
    expect(await loginShellPathDirs({ platform: "darwin" })).toEqual([]);
    expect(logMock).toHaveBeenCalledWith({ tag: "agent-cli", op: "login_shell_probe_error" }, expect.any(String));
    expectCountsOnlyLogs();
  });

  it("times out: SIGTERM to its process group, SIGKILL 500 ms later, [] only after the 1 s exit wait; a survivor is counted; no retry", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new FakeChild(), { pid: 900_101 });
      spawnMock.mockReturnValue(child);
      const m = await import("@/lib/agents/cli/login-shell-path");
      let settled = false;
      const p = m.loginShellPathDirs({ platform: "darwin" }).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(m.LOGIN_SHELL_PROBE_TIMEOUT_MS);
      expect(killSpy).toHaveBeenCalledWith(-900_101, "SIGTERM");
      // Output that lands after the timeout is never applied.
      child.stdout.emit("data", Buffer.from("__LIBI_PATH_START__/late/bin__LIBI_PATH_END__"));
      await vi.advanceTimersByTimeAsync(m.LOGIN_SHELL_PROBE_KILL_GRACE_MS - 1);
      expect(killSpy).not.toHaveBeenCalledWith(-900_101, "SIGKILL");
      await vi.advanceTimersByTimeAsync(1);
      // The negative pid — the whole group — and never the bare pid or child.kill.
      expect(killSpy.mock.calls).toEqual([[-900_101, "SIGTERM"], [-900_101, "SIGKILL"]]);
      expect(child.kill).not.toHaveBeenCalled();
      // Never exits: the caller is still waiting one tick before the exit wait ends…
      await vi.advanceTimersByTimeAsync(m.LOGIN_SHELL_PROBE_EXIT_WAIT_MS - 1);
      expect(settled).toBe(false);
      // …and is released exactly when it ends, with the survivor counted.
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toEqual([]);
      expect(spawnMock).toHaveBeenCalledTimes(1); // one attempt — retries are the desktop probe's alone
      expect(logMock).toHaveBeenCalledWith(
        { tag: "agent-cli", op: "login_shell_probe_timeout", killed: 1, notExitedAfterKill: 1 },
        expect.any(String),
      );
      expectCountsOnlyLogs();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a shell that exits after SIGKILL releases the caller at its exit, not at the end of the wait, and is not counted", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new FakeChild(), { pid: 900_102 });
      spawnMock.mockReturnValue(child);
      // Once the shell has exited its group is empty.
      killSpy.mockImplementation(((_pid: number, sig?: string | number) => (sig === 0 ? errno("ESRCH") : true)) as typeof process.kill);
      const m = await import("@/lib/agents/cli/login-shell-path");
      const p = m.loginShellPathDirs({ platform: "darwin" });
      await vi.advanceTimersByTimeAsync(m.LOGIN_SHELL_PROBE_TIMEOUT_MS + m.LOGIN_SHELL_PROBE_KILL_GRACE_MS);
      expect(killSpy).toHaveBeenCalledWith(-900_102, "SIGKILL");
      child.stdout.emit("data", Buffer.from("__LIBI_PATH_START__/late/bin__LIBI_PATH_END__"));
      child.emit("exit", null, "SIGKILL");
      child.emit("close", null, "SIGKILL"); // a late close never resolves with the late output
      expect(await p).toEqual([]); // no timer advanced: the exit alone released it
      expect(logMock).toHaveBeenCalledWith(
        { tag: "agent-cli", op: "login_shell_probe_timeout", killed: 1, notExitedAfterKill: 0 },
        expect.any(String),
      );
      expectCountsOnlyLogs();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out, the shell exits after SIGKILL but its group keeps a member (EPERM throughout): the caller is released when the exit wait is up, with the survivor counted", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new FakeChild(), { pid: 900_107 });
      spawnMock.mockReturnValue(child);
      killSpy.mockImplementation(((_pid: number, sig?: string | number) => (sig === 0 ? errno("EPERM") : true)) as typeof process.kill);
      const m = await import("@/lib/agents/cli/login-shell-path");
      let settled = false;
      const p = m.loginShellPathDirs({ platform: "darwin" }).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(m.LOGIN_SHELL_PROBE_TIMEOUT_MS + m.LOGIN_SHELL_PROBE_KILL_GRACE_MS);
      expect(killSpy).toHaveBeenCalledWith(-900_107, "SIGKILL");
      child.emit("exit", null, "SIGKILL");
      await vi.advanceTimersByTimeAsync(m.LOGIN_SHELL_PROBE_EXIT_WAIT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toEqual([]);
      expect(logMock).toHaveBeenCalledWith(
        { tag: "agent-cli", op: "login_shell_probe_timeout", killed: 1, notExitedAfterKill: 1 },
        expect.any(String),
      );
      expectCountsOnlyLogs();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a child without a pid is signalled directly — child.kill(SIGTERM) then child.kill(SIGKILL) — and [] arrives at the end of the budget", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      spawnMock.mockReturnValue(child);
      const m = await import("@/lib/agents/cli/login-shell-path");
      const p = m.loginShellPathDirs({ platform: "darwin" });
      await vi.advanceTimersByTimeAsync(
        m.LOGIN_SHELL_PROBE_TIMEOUT_MS + m.LOGIN_SHELL_PROBE_KILL_GRACE_MS + m.LOGIN_SHELL_PROBE_EXIT_WAIT_MS,
      );
      expect(await p).toEqual([]);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("memoizes for 5 s — a second call within the window spawns nothing", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const { loginShellPathDirs } = await import("@/lib/agents/cli/login-shell-path");
    let now = 1_000;
    const p = loginShellPathDirs({ platform: "darwin", now: () => now });
    child.stdout.emit("data", Buffer.from("__LIBI_PATH_START__/a__LIBI_PATH_END__"));
    child.emit("close", 0);
    await p;
    now += 4_000;
    expect(await loginShellPathDirs({ platform: "darwin", now: () => now })).toEqual(["/a"]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    now += 2_000;
    const third = new FakeChild();
    spawnMock.mockReturnValue(third);
    const p3 = loginShellPathDirs({ platform: "darwin", now: () => now });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    third.emit("close", 0); // settle it: a real 2 s timer must not fire into a later test
    await p3;
  });

  it("returns [] on win32 without spawning, and falls back to /bin/bash on linux when $SHELL is unset", async () => {
    const { loginShellPathDirs } = await import("@/lib/agents/cli/login-shell-path");
    expect(await loginShellPathDirs({ platform: "win32" })).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
    delete process.env.SHELL;
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const p = loginShellPathDirs({ platform: "linux" });
    expect(spawnMock.mock.calls[0][0]).toBe("/bin/bash");
    child.emit("error", new Error("ENOENT"));
    expect(await p).toEqual([]);
    expectCountsOnlyLogs();
  });
});
