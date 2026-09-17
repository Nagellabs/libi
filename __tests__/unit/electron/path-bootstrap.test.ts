import { describe, expect, it, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `electron/path-bootstrap.ts` must never let boot depend on the OS
 * answering a login-shell PATH probe. See its docblock for the real
 * incident this guards against: a spawned `/bin/zsh` parked inside a macOS TCC/sandbox
 * authorization wait that never replied, for which `execSync`'s SIGTERM
 * timeout is powerless (a blocked-in-kernel process isn't reaped by
 * SIGTERM).
 *
 * These tests mock `child_process.spawn` so we control exactly when (or
 * whether) the probe "completes", without needing a real hung shell.
 */

const spawnMock = vi.fn();
// Slow enough to bite the `elapsed < 200ms` assertion below if the module
// under test regresses to the pre-fix `execSync(..., { timeout: 2000 })`
// probe (see the bite-check note on that test). Only the OLD code path ever
// calls `execSync` — the current module never does, so this is inert cost
// against the real implementation.
const EXEC_SYNC_MOCK_DELAY_MS = 250;
// A real, OS-level blocking wait — NOT `Date.now()`-based. Several tests in
// this file use `vi.useFakeTimers()`, which also freezes `Date.now()`; a
// busy-wait keyed on `Date.now()` would spin forever once the clock stops
// advancing on its own. `Atomics.wait` blocks the thread for real wall-clock
// time regardless of any fake-timer/fake-Date state.
const execSyncDelaySab = new Int32Array(new SharedArrayBuffer(4));
const execSyncMock = vi.fn((..._args: unknown[]): string => {
  Atomics.wait(execSyncDelaySab, 0, 0, EXEC_SYNC_MOCK_DELAY_MS);
  return "";
});

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));

// ── add at the top, after the child_process mock ──────────────────────────
const logLines: string[] = [];
vi.mock("../../../electron/sync-log", () => ({
  mainSyncLog: (line: string) => {
    logLines.push(line);
  },
}));

/** A fake ChildProcess good enough for path-bootstrap's needs. */
class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { unref: vi.fn(), destroy: vi.fn() });
  unref = vi.fn();
  kill = vi.fn();
  pid: number | undefined = undefined;
}

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

let libiHome: string;
let envSnapshot: NodeJS.ProcessEnv;
let killSpy: MockInstance<typeof process.kill>;

beforeEach(() => {
  envSnapshot = { ...process.env };
  libiHome = mkdtempSync(path.join(tmpdir(), "libi-path-bootstrap-"));
  process.env.LIBI_HOME = libiHome;
  process.env.HOME = "/Users/testuser";
  process.env.SHELL = "/bin/zsh";
  process.env.PATH = "/usr/bin:/bin";
  spawnMock.mockReset();
  execSyncMock.mockClear();
  logLines.length = 0;
  vi.resetModules();
  for (const k of ["FAL_KEY", "EXISTING", "HALF", "LATE_VAR", "NODE_OPTIONS", "LIBI_SHELL_ENV"]) delete process.env[k];
  // The default kernel: a group signal reaches something, and once the exit wait is over the
  // liveness probe (signal 0) finds the group empty — every member died of the SIGKILL.
  killSpy = vi.spyOn(process, "kill").mockImplementation(((_pid: number, signal?: string | number) => {
    if (signal === 0) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    return true;
  }) as typeof process.kill);
});

afterEach(async () => {
  (await import("../../../electron/path-bootstrap")).stopShellEnvProbe();
  process.env = envSnapshot;
  rmSync(libiHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function cacheFile(): string {
  return path.join(libiHome, "shell-path-cache.json");
}

describe("bootstrapPath — boot must never wait on the probe", () => {
  it("returns promptly even when the probe child never exits and never closes stdout (bite-check target)", async () => {
    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const { bootstrapPath } = await import("../../../electron/path-bootstrap");

    const start = performance.now();
    withPlatform("darwin", () => bootstrapPath());
    const elapsed = performance.now() - start;

    // No timeout, no data, no close/error ever fires on fakeChild. If
    // bootstrapPath() still blocked on the probe (e.g. via execSync), this
    // call would hang for seconds/forever rather than returning in a few ms.
    expect(elapsed).toBeLessThan(200);

    // And the probe was attempted (async, in the background) — spawn was
    // called even though it will never resolve.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("unrefs the child, its stdout pipe, and the guard timer (defense-in-depth against a process-exit hang — NOT what protects boot; see docblock)", async () => {
    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);

    // `child.unref()` alone does NOT unref the stdout pipe — attaching a
    // "data" listener puts that separate libuv handle into flowing mode,
    // which refs the loop on its own. Prove the pipe is unref'd too by
    // capturing the real timer object path-bootstrap creates and spying on
    // its `unref` method directly (a plain call-count on `fakeChild` can't
    // observe this — the timer belongs to the module under test, not our
    // fake).
    const originalSetTimeout = globalThis.setTimeout;
    let capturedTimer: NodeJS.Timeout | undefined;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        const timer = originalSetTimeout(fn, ms, ...args);
        vi.spyOn(timer, "unref");
        capturedTimer = timer;
        return timer;
      }) as typeof setTimeout);

    try {
      const { bootstrapPath } = await import("../../../electron/path-bootstrap");
      withPlatform("darwin", () => bootstrapPath());

      expect(fakeChild.unref).toHaveBeenCalledTimes(1);
      expect(fakeChild.stdout.unref).toHaveBeenCalled();
      expect(capturedTimer).toBeDefined();
      expect(capturedTimer!.unref).toHaveBeenCalledTimes(1);
    } finally {
      // Real 2s guard timer — never let it fire after the test ends.
      if (capturedTimer) clearTimeout(capturedTimer);
      setTimeoutSpy.mockRestore();
    }
  });

  it("PATH is usable immediately on return: contains the libi bin dir and the hardcoded fallbacks", async () => {
    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const { bootstrapPath } = await import("../../../electron/path-bootstrap");
    withPlatform("darwin", () => bootstrapPath());

    const finalPath = process.env.PATH ?? "";
    // The CURRENT libi home's bin dir, not a hardcoded `$HOME/.libi/bin`.
    // `LIBI_HOME` here is a temp dir while `HOME` is /Users/testuser, which is
    // exactly the packaged-app shape (home = ~/Library/Application Support/libi):
    // hardcoding put the DEVELOPER's bin dir on the packaged app's PATH and left
    // the app's own binaries — including the node runtime Category A provisions
    // — invisible.
    expect(finalPath).toContain(path.join(libiHome, "bin"));
    expect(finalPath).not.toContain(path.join("/Users/testuser", ".libi", "bin"));
    expect(finalPath).toContain("/opt/homebrew/bin");
    expect(finalPath).toContain("/usr/local/bin");
    // Original PATH is preserved, not clobbered.
    expect(finalPath).toContain("/usr/bin");
  });

  it("never throws even if spawn itself throws synchronously", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("boom");
    });

    const { bootstrapPath } = await import("../../../electron/path-bootstrap");
    expect(() => withPlatform("darwin", () => bootstrapPath())).not.toThrow();
    expect(process.env.PATH ?? "").toContain("/opt/homebrew/bin");
  });

  it("is idempotent: calling twice does not duplicate PATH entries", async () => {
    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const { bootstrapPath } = await import("../../../electron/path-bootstrap");
    withPlatform("darwin", () => {
      bootstrapPath();
      bootstrapPath();
    });

    const entries = (process.env.PATH ?? "").split(":").filter(Boolean);
    expect(entries.length).toBe(new Set(entries).size);
  });
});

/** NUL-framed `env -0` body, exactly what the probe prints between the markers. */
function envBody(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([k, v]) => `${k}=${v}\0`)
    .join("");
}

/** A child that closes at once without either marker — an incomplete capture. */
function closesIncomplete(): FakeChild {
  const child = new FakeChild();
  void Promise.resolve().then(() => child.emit("close", 1));
  return child;
}

describe("parseEnvProbeOutput", () => {
  it("frames the body between the markers and ignores banner noise on either side", async () => {
    const { parseEnvProbeOutput, ENV_START_MARKER, ENV_END_MARKER } = await import(
      "../../../electron/path-bootstrap"
    );
    const out = `Welcome!\nfortune says hi\n${ENV_START_MARKER}${envBody({ PATH: "/a:/b", FOO: "bar" })}${ENV_END_MARKER}\nbye\n`;
    const parsed = parseEnvProbeOutput(out);
    expect(parsed.complete).toBe(true);
    expect(parsed.path).toBe("/a:/b");
    expect(parsed.entries).toEqual([
      ["PATH", "/a:/b"],
      ["FOO", "bar"],
    ]);
  });

  it("keeps a value that itself contains a newline (NUL is the delimiter, not \\n)", async () => {
    const { parseEnvProbeOutput, ENV_START_MARKER, ENV_END_MARKER } = await import(
      "../../../electron/path-bootstrap"
    );
    const parsed = parseEnvProbeOutput(
      `${ENV_START_MARKER}${envBody({ MULTI: "line1\nline2", PATH: "/x" })}${ENV_END_MARKER}`,
    );
    expect(parsed.entries).toContainEqual(["MULTI", "line1\nline2"]);
    expect(parsed.path).toBe("/x");
  });

  it("without the end marker: incomplete, and only NUL-terminated entries count", async () => {
    const { parseEnvProbeOutput, ENV_START_MARKER } = await import("../../../electron/path-bootstrap");
    // PATH is complete (terminated), FOO was cut mid-value.
    const parsed = parseEnvProbeOutput(`${ENV_START_MARKER}PATH=/complete:/bin\0FOO=cut-off-he`);
    expect(parsed.complete).toBe(false);
    expect(parsed.path).toBe("/complete:/bin");
    expect(parsed.entries).toEqual([["PATH", "/complete:/bin"]]);
  });

  it("without the start marker: nothing at all", async () => {
    const { parseEnvProbeOutput } = await import("../../../electron/path-bootstrap");
    expect(parseEnvProbeOutput("PATH=/a\0")).toEqual({ complete: false, entries: [], path: null });
  });
});

describe("isBlockedEnvName", () => {
  it("blocks every name and prefix on the list — including the state variable a profile must never set", async () => {
    const { isBlockedEnvName } = await import("../../../electron/path-bootstrap");
    for (const name of [
      "LIBI_HOME", "LIBI_PORT", "LIBI_SHELL_ENV", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH", "NODE_ENV",
      "PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "CONDA_PREFIX", "DYLD_LIBRARY_PATH",
      "LD_PRELOAD", "LD_LIBRARY_PATH", "PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID",
      "TMUX", "TMUX_PANE", "FNM_MULTISHELL_PATH", "BASH_FUNC_foo%%",
    ]) {
      expect(isBlockedEnvName(name), name).toBe(true);
    }
  });
  it("lets ordinary variables through — including CODEX_HOME and CLAUDE_CONFIG_DIR", async () => {
    const { isBlockedEnvName } = await import("../../../electron/path-bootstrap");
    for (const name of ["FAL_KEY", "HOMEBREW_PREFIX", "LANG", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "FNM_DIR"]) {
      expect(isBlockedEnvName(name), name).toBe(false);
    }
  });
});

describe("mergeShellEnv", () => {
  it("is add-only, skips PATH, and counts what it blocked", async () => {
    const { mergeShellEnv } = await import("../../../electron/path-bootstrap");
    const target: NodeJS.ProcessEnv = { EXISTING: "keep-me", PATH: "/orig" } as unknown as NodeJS.ProcessEnv;
    const r = mergeShellEnv(
      [["EXISTING", "clobber"], ["FAL_KEY", "k"], ["NODE_OPTIONS", "--x"], ["PATH", "/shell"]],
      target,
    );
    expect(target.EXISTING).toBe("keep-me");
    expect(target.FAL_KEY).toBe("k");
    expect(target.NODE_OPTIONS).toBeUndefined();
    expect(target.PATH).toBe("/orig");
    expect(r).toEqual({ added: 1, blocked: 1 });
  });
});

describe("bootstrapPath — one probe attempt", () => {
  it("spawns `$SHELL -ilc` with the marker-framed env -0 command in its OWN process group, and publishes `pending`", async () => {
    spawnMock.mockReturnValue(new FakeChild());
    const { bootstrapPath, ENV_START_MARKER, ENV_END_MARKER } = await import(
      "../../../electron/path-bootstrap"
    );
    withPlatform("darwin", () => bootstrapPath());
    expect(spawnMock).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-ilc", `printf ${ENV_START_MARKER}; env -0; printf ${ENV_END_MARKER}`],
      expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"], detached: true }),
    );
    expect(process.env.LIBI_SHELL_ENV).toBe("pending");
  });

  it("falls back to /bin/zsh on darwin and /bin/bash on linux when $SHELL is unset", async () => {
    delete process.env.SHELL;
    const { probeShell } = await import("../../../electron/path-bootstrap");
    expect(withPlatform("darwin", () => probeShell())).toBe("/bin/zsh");
    expect(withPlatform("linux", () => probeShell())).toBe("/bin/bash");
  });

  it("on a complete capture: merges PATH (prepend), imports add-only, caches PATH ONLY, and sets `loaded`", async () => {
    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);
    process.env.EXISTING = "keep-me";
    const { bootstrapPath, ENV_START_MARKER, ENV_END_MARKER } = await import(
      "../../../electron/path-bootstrap"
    );
    const { probeSettled } = withPlatform("darwin", () => bootstrapPath());
    fakeChild.stdout.emit(
      "data",
      Buffer.from(
        `${ENV_START_MARKER}${envBody({ PATH: "/opt/discovered/bin:/usr/bin", FAL_KEY: "secret-value-1", EXISTING: "clobber", NODE_OPTIONS: "--bad", LIBI_HOME: "/evil" })}${ENV_END_MARKER}`,
      ),
    );
    fakeChild.emit("close", 0);
    await probeSettled;
    expect(process.env.LIBI_SHELL_ENV).toBe("loaded");
    expect(process.env.PATH!.split(":")).toContain("/opt/discovered/bin");
    expect(process.env.FAL_KEY).toBe("secret-value-1");
    expect(process.env.EXISTING).toBe("keep-me");
    expect(process.env.NODE_OPTIONS).toBeUndefined();
    expect(process.env.LIBI_HOME).toBe(libiHome);
    // The cache holds PATH and the shell name — nothing else, ever.
    const cache = JSON.parse(readFileSync(cacheFile(), "utf8"));
    expect(Object.keys(cache).sort()).toEqual(["path", "shell"]);
    expect(JSON.stringify(cache)).not.toContain("secret-value-1");
    // Counts only in the log — never a name, a value, the $SHELL value, or a path.
    const done = logLines.find((l) => l.includes("shell_env_probe_done"));
    expect(done).toMatch(
      /state=loaded attempts=1 failures=0 killed=0 killedAfterSuccess=0 notExitedAfterKill=0 added=1 blocked=2 ms=\d+$/,
    );
    expect(logLines.join("\n")).not.toContain("secret-value-1");
    expect(logLines.join("\n")).not.toContain("FAL_KEY");
    expect(logLines.join("\n")).not.toContain("/bin/zsh");
    expect(logLines.join("\n")).not.toContain("/opt/discovered/bin");
  });

  it("decodes the capture ONCE, from its bytes: a multi-byte character split across chunks arrives byte-exact in PATH, its cache and every imported value", async () => {
    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);
    const { bootstrapPath, ENV_START_MARKER, ENV_END_MARKER } = await import(
      "../../../electron/path-bootstrap"
    );
    const discovered = "/opt/caf\u00e9\u20ac/bin";
    const value = "price \u20ac42 \u2014 na\u00efve";
    const bytes = Buffer.from(
      `${ENV_START_MARKER}${envBody({ PATH: `${discovered}:/usr/bin`, LATE_VAR: value })}${ENV_END_MARKER}`,
    );
    const euro = Buffer.from("\u20ac"); // three bytes in UTF-8
    const cut1 = bytes.indexOf(euro) + 1; // one byte into PATH's euro sign
    const cut2 = bytes.indexOf(euro, cut1 + euro.length) + 2; // two bytes into LATE_VAR's
    const { probeSettled } = withPlatform("darwin", () => bootstrapPath());
    fakeChild.stdout.emit("data", bytes.subarray(0, cut1));
    fakeChild.stdout.emit("data", bytes.subarray(cut1, cut2));
    fakeChild.stdout.emit("data", bytes.subarray(cut2));
    fakeChild.emit("close", 0);
    await probeSettled;
    expect(process.env.LIBI_SHELL_ENV).toBe("loaded");
    expect(process.env.LATE_VAR).toBe(value);
    expect(process.env.PATH!.split(":")).toContain(discovered);
    expect(process.env.PATH).not.toContain("\ufffd");
    expect(JSON.parse(readFileSync(cacheFile(), "utf8")).path).toBe(`${discovered}:/usr/bin`);
  });

  it("on timeout: applies PATH only from a complete entry, imports nothing else, signals the attempt's process GROUP, and never applies output that arrives after the bound", async () => {
    vi.useFakeTimers();
    try {
      const fakeChild = Object.assign(new FakeChild(), { pid: 900_003 });
      spawnMock.mockReturnValueOnce(fakeChild).mockImplementation(() => new FakeChild());
      const { bootstrapPath, ENV_START_MARKER, ENV_END_MARKER, SHELL_PROBE_TIMEOUT_MS, SHELL_PROBE_KILL_GRACE_MS } =
        await import("../../../electron/path-bootstrap");
      withPlatform("darwin", () => bootstrapPath());
      fakeChild.stdout.emit(
        "data",
        Buffer.from(`${ENV_START_MARKER}PATH=/opt/partial/bin:/usr/bin\0FAL_KEY=secret-value-2\0HALF=cut`),
      );
      await vi.advanceTimersByTimeAsync(SHELL_PROBE_TIMEOUT_MS);
      expect(process.env.PATH!.split(":")).toContain("/opt/partial/bin");
      expect(process.env.FAL_KEY).toBeUndefined();
      expect(process.env.HALF).toBeUndefined();
      expect(killSpy).toHaveBeenCalledWith(-900_003, "SIGTERM");
      expect(process.env.LIBI_SHELL_ENV).toBe("pending");
      // SIGTERM ended the profile's hang and the shell finished — after the bound. Not applied.
      fakeChild.stdout.emit("data", Buffer.from(`-rest\0LATE_VAR=late\0${ENV_END_MARKER}`));
      fakeChild.emit("exit", 0, null);
      fakeChild.emit("close", 0);
      await vi.advanceTimersByTimeAsync(SHELL_PROBE_KILL_GRACE_MS);
      expect(killSpy).toHaveBeenCalledWith(-900_003, "SIGKILL");
      expect(process.env.LATE_VAR).toBeUndefined();
      expect(logLines.find((l) => l.includes("shell_env_probe_attempt_failed"))).toMatch(
        /attempt=1 cause=timeout pathApplied=true exited=true$/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("on timeout with NO complete PATH entry: applies and caches nothing", async () => {
    vi.useFakeTimers();
    try {
      const fakeChild = new FakeChild();
      spawnMock.mockReturnValue(fakeChild);
      const { bootstrapPath, ENV_START_MARKER, SHELL_PROBE_TIMEOUT_MS } = await import(
        "../../../electron/path-bootstrap"
      );
      const before = process.env.PATH;
      withPlatform("darwin", () => bootstrapPath());
      const after = process.env.PATH; // the synchronous fallback is already applied
      fakeChild.stdout.emit("data", Buffer.from(`${ENV_START_MARKER}PATH=/opt/cut`));
      await vi.advanceTimersByTimeAsync(SHELL_PROBE_TIMEOUT_MS);
      expect(process.env.PATH).toBe(after);
      expect(process.env.PATH).not.toBe(before);
      expect(existsSync(cacheFile())).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("on a spawn error: imports nothing, caches nothing, logs the code only — and the close Node emits after the error is ignored", async () => {
    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);
    const { bootstrapPath } = await import("../../../electron/path-bootstrap");
    withPlatform("darwin", () => bootstrapPath());
    fakeChild.emit("error", Object.assign(new Error("spawn /bin/zsh ENOENT"), { code: "ENOENT" }));
    fakeChild.emit("close", -2); // Node emits `error` then `close` on a spawn ENOENT
    await vi.waitFor(() =>
      expect(logLines.find((l) => l.includes("shell_env_probe_attempt_failed"))).toMatch(
        /attempt=1 cause=error code=ENOENT$/,
      ),
    );
    expect(logLines.filter((l) => l.includes("shell_env_probe_attempt_failed"))).toHaveLength(1);
    expect(existsSync(cacheFile())).toBe(false);
    expect(process.env.LIBI_SHELL_ENV).toBe("pending"); // a retry is scheduled
    expect(logLines.join("\n")).not.toContain("/bin/zsh");
  });

  it("applies the environment ONLY when both markers are present — an early close with an incomplete capture applies NOTHING, not even PATH", async () => {
    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);
    const { bootstrapPath, ENV_START_MARKER } = await import("../../../electron/path-bootstrap");
    withPlatform("darwin", () => bootstrapPath());
    const pathBefore = process.env.PATH;
    fakeChild.stdout.emit("data", Buffer.from(`${ENV_START_MARKER}PATH=/p\0FAL_KEY=v\0`));
    fakeChild.emit("close", 0); // shell died before printing the end marker
    await vi.waitFor(() =>
      expect(logLines.find((l) => l.includes("shell_env_probe_attempt_failed"))).toMatch(
        /attempt=1 cause=incomplete$/,
      ),
    );
    expect(process.env.FAL_KEY).toBeUndefined();
    // Only the TIMEOUT path may trust a complete PATH entry from a partial capture;
    // a shell that closed without the end marker is not trusted at all.
    expect(process.env.PATH).toBe(pathBefore);
    expect(process.env.PATH!.split(":")).not.toContain("/p");
    expect(existsSync(cacheFile())).toBe(false);
  });
});

describe("bootstrapPath — attempts, kill and state", () => {
  it("five failed attempts end in `failed`: exactly 5 spawns, on the 1 s / 2 s / 4 s / 8 s backoff", async () => {
    vi.useFakeTimers();
    try {
      spawnMock.mockImplementation(() => closesIncomplete());
      const { bootstrapPath, SHELL_PROBE_BACKOFF_MS, SHELL_PROBE_MAX_ATTEMPTS } = await import(
        "../../../electron/path-bootstrap"
      );
      expect(SHELL_PROBE_MAX_ATTEMPTS).toBe(5);
      expect(SHELL_PROBE_BACKOFF_MS).toEqual([1000, 2000, 4000, 8000]);
      const { probeSettled } = withPlatform("darwin", () => bootstrapPath());
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      for (const [i, wait] of [1000, 2000, 4000, 8000].entries()) {
        await vi.advanceTimersByTimeAsync(wait - 1);
        expect(spawnMock, `just before attempt ${i + 2}`).toHaveBeenCalledTimes(i + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(spawnMock, `attempt ${i + 2}`).toHaveBeenCalledTimes(i + 2);
      }
      await probeSettled;
      expect(process.env.LIBI_SHELL_ENV).toBe("failed");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spawnMock).toHaveBeenCalledTimes(5); // the next launch starts over; this one is done
      expect(logLines.filter((l) => l.includes("shell_env_probe_attempt_failed"))).toHaveLength(5);
      expect(logLines.find((l) => l.includes("shell_env_probe_done"))).toMatch(
        /state=failed attempts=5 failures=5 killed=0 killedAfterSuccess=0 notExitedAfterKill=0 added=0 blocked=0 ms=\d+$/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("success on a later attempt merges the environment and sets `loaded`", async () => {
    vi.useFakeTimers();
    try {
      const { bootstrapPath, ENV_START_MARKER, ENV_END_MARKER, SHELL_PROBE_BACKOFF_MS } = await import(
        "../../../electron/path-bootstrap"
      );
      spawnMock
        .mockImplementationOnce(() => closesIncomplete())
        .mockImplementationOnce(() => closesIncomplete())
        .mockImplementationOnce(() => {
          const child = new FakeChild();
          void Promise.resolve().then(() => {
            child.stdout.emit(
              "data",
              Buffer.from(`${ENV_START_MARKER}${envBody({ PATH: "/third/bin:/usr/bin", LATE_VAR: "arrived" })}${ENV_END_MARKER}`),
            );
            child.emit("close", 0);
          });
          return child;
        });
      const { probeSettled } = withPlatform("darwin", () => bootstrapPath());
      await vi.advanceTimersByTimeAsync(SHELL_PROBE_BACKOFF_MS[0] + SHELL_PROBE_BACKOFF_MS[1]);
      await probeSettled;
      expect(spawnMock).toHaveBeenCalledTimes(3);
      expect(process.env.LIBI_SHELL_ENV).toBe("loaded");
      expect(process.env.LATE_VAR).toBe("arrived");
      expect(process.env.PATH!.split(":")).toContain("/third/bin");
      expect(logLines.find((l) => l.includes("shell_env_probe_done"))).toMatch(
        /state=loaded attempts=3 failures=2 killed=0 killedAfterSuccess=0 notExitedAfterKill=0 added=1 blocked=0 ms=\d+$/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a complete capture succeeds at once even when a profile's background job keeps the pipe open: `loaded` before the timeout, one attempt, and the group is still terminated", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new FakeChild(), { pid: 900_004 });
      spawnMock.mockReturnValueOnce(child).mockImplementation(() => new FakeChild());
      const m = await import("../../../electron/path-bootstrap");
      const { probeSettled } = withPlatform("darwin", () => m.bootstrapPath());
      // The end marker lands in its own chunk; the shell exits, but a background job it
      // started inherited stdout, so `close` NEVER fires.
      child.stdout.emit(
        "data",
        Buffer.from(`${m.ENV_START_MARKER}${envBody({ PATH: "/bg/bin:/usr/bin", LATE_VAR: "arrived", NODE_OPTIONS: "--bad" })}`),
      );
      child.stdout.emit("data", Buffer.from(`${m.ENV_END_MARKER}\n`));
      child.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(0);
      expect(process.env.LIBI_SHELL_ENV).toBe("loaded");
      expect(process.env.LATE_VAR).toBe("arrived");
      expect(process.env.NODE_OPTIONS).toBeUndefined();
      expect(process.env.PATH!.split(":")).toContain("/bg/bin");
      expect(JSON.parse(readFileSync(cacheFile(), "utf8")).path).toBe("/bg/bin:/usr/bin");
      expect(spawnMock).toHaveBeenCalledTimes(1);
      // Still our probe: its group gets the same SIGTERM -> 500 ms -> SIGKILL sequence.
      expect(killSpy).toHaveBeenCalledWith(-900_004, "SIGTERM");
      await vi.advanceTimersByTimeAsync(m.SHELL_PROBE_KILL_GRACE_MS - 1);
      expect(killSpy).not.toHaveBeenCalledWith(-900_004, "SIGKILL");
      await vi.advanceTimersByTimeAsync(1);
      expect(killSpy).toHaveBeenCalledWith(-900_004, "SIGKILL");
      await probeSettled;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(process.env.LIBI_SHELL_ENV).toBe("loaded");
      expect(logLines.filter((l) => l.includes("shell_env_probe_attempt_failed"))).toHaveLength(0);
      // The termination after a success is not a failure, and is counted on its own.
      expect(logLines.find((l) => l.includes("shell_env_probe_done"))).toMatch(
        /state=loaded attempts=1 failures=0 killed=0 killedAfterSuccess=1 notExitedAfterKill=0 added=1 blocked=1 ms=\d+$/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("an end marker split across two chunks while the pipe stays open still succeeds at once: the bytes carried over from the first chunk complete the marker, and the timeout is never needed", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new FakeChild(), { pid: 900_011 });
      // The shell has exited; whatever holds the pipe open lives outside the group.
      killSpy.mockImplementation((() => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }) as typeof process.kill);
      spawnMock.mockReturnValueOnce(child).mockImplementation(() => new FakeChild());
      const m = await import("../../../electron/path-bootstrap");
      const { probeSettled } = withPlatform("darwin", () => m.bootstrapPath());
      const cut = Math.floor(m.ENV_END_MARKER.length / 2);
      child.stdout.emit(
        "data",
        Buffer.from(
          `${m.ENV_START_MARKER}${envBody({ PATH: "/split/bin:/usr/bin", LATE_VAR: "arrived" })}${m.ENV_END_MARKER.slice(0, cut)}`,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(process.env.LIBI_SHELL_ENV).toBe("pending"); // half a marker is not a frame
      child.stdout.emit("data", Buffer.from(`${m.ENV_END_MARKER.slice(cut)}\n`));
      child.emit("exit", 0, null); // `close` never fires: the pipe stays open
      await vi.advanceTimersByTimeAsync(0);
      expect(process.env.LIBI_SHELL_ENV).toBe("loaded");
      expect(process.env.LATE_VAR).toBe("arrived");
      expect(process.env.PATH!.split(":")).toContain("/split/bin");
      await probeSettled;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(logLines.filter((l) => l.includes("shell_env_probe_attempt_failed"))).toHaveLength(0);
      expect(logLines.find((l) => l.includes("shell_env_probe_done"))).toMatch(
        /state=loaded attempts=1 failures=0 killed=0 killedAfterSuccess=0 notExitedAfterKill=0 added=1 blocked=0 ms=\d+$/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a shell that exits promptly after its capture is not signalled mid-exit: no SIGTERM before its `exit`, nothing counted, nothing waited for", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new FakeChild(), { pid: 900_007 });
      let childExited = false;
      child.on("exit", () => {
        childExited = true;
      });
      // The kernel: once the shell has exited and nothing else is in its group, the group is gone.
      killSpy.mockImplementation(((pid: number) => {
        if (pid === -900_007 && childExited) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
        return true;
      }) as typeof process.kill);
      spawnMock.mockReturnValueOnce(child).mockImplementation(() => new FakeChild());
      const m = await import("../../../electron/path-bootstrap");
      const { probeSettled } = withPlatform("darwin", () => m.bootstrapPath());
      child.stdout.emit(
        "data",
        Buffer.from(`${m.ENV_START_MARKER}${envBody({ PATH: "/prompt/bin:/usr/bin", LATE_VAR: "arrived" })}${m.ENV_END_MARKER}`),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(process.env.LIBI_SHELL_ENV).toBe("loaded");
      await vi.advanceTimersByTimeAsync(10);
      // Mid-exit: the shell printed its capture and is on its way out. Not signalled.
      expect(killSpy).not.toHaveBeenCalledWith(-900_007, "SIGTERM");
      child.emit("exit", 0, null); // exits promptly; `close` is never reported
      await vi.advanceTimersByTimeAsync(0);
      await probeSettled; // no grace and no exit wait to sit through
      expect(killSpy).not.toHaveBeenCalledWith(-900_007, "SIGKILL");
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(logLines.find((l) => l.includes("shell_env_probe_done"))).toMatch(
        /state=loaded attempts=1 failures=0 killed=0 killedAfterSuccess=0 notExitedAfterKill=0 added=1 blocked=0 ms=\d+$/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a shell still alive when its short exit chance after the capture is up IS signalled, and one that survives SIGKILL is counted (killedAfterSuccess + notExitedAfterKill)", async () => {
    vi.useFakeTimers();
    try {
      // Never exits, never closes, and the group stays alive.
      const child = Object.assign(new FakeChild(), { pid: 900_008 });
      spawnMock.mockReturnValueOnce(child).mockImplementation(() => new FakeChild());
      const m = await import("../../../electron/path-bootstrap");
      const { probeSettled } = withPlatform("darwin", () => m.bootstrapPath());
      let settledAt: number | null = null;
      void probeSettled.then(() => {
        settledAt = Date.now();
      });
      child.stdout.emit(
        "data",
        Buffer.from(`${m.ENV_START_MARKER}${envBody({ PATH: "/stuck/bin:/usr/bin" })}${m.ENV_END_MARKER}`),
      );
      const capturedAt = Date.now();
      await vi.advanceTimersByTimeAsync(0);
      expect(process.env.LIBI_SHELL_ENV).toBe("loaded");
      expect(killSpy).not.toHaveBeenCalledWith(-900_008, "SIGTERM");
      await vi.advanceTimersByTimeAsync(m.SHELL_PROBE_EXIT_CHANCE_MS - 1);
      expect(killSpy).not.toHaveBeenCalledWith(-900_008, "SIGTERM");
      await vi.advanceTimersByTimeAsync(1);
      expect(killSpy).toHaveBeenCalledWith(-900_008, "SIGTERM");
      await vi.advanceTimersByTimeAsync(m.SHELL_PROBE_KILL_GRACE_MS - 1);
      expect(killSpy).not.toHaveBeenCalledWith(-900_008, "SIGKILL");
      await vi.advanceTimersByTimeAsync(1);
      expect(killSpy).toHaveBeenCalledWith(-900_008, "SIGKILL");
      await vi.advanceTimersByTimeAsync(m.SHELL_PROBE_EXIT_WAIT_MS);
      await probeSettled;
      expect(settledAt! - capturedAt).toBe(
        m.SHELL_PROBE_EXIT_CHANCE_MS + m.SHELL_PROBE_KILL_GRACE_MS + m.SHELL_PROBE_EXIT_WAIT_MS,
      );
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(logLines.filter((l) => l.includes("shell_env_probe_attempt_failed"))).toHaveLength(0);
      expect(logLines.find((l) => l.includes("shell_env_probe_done"))).toMatch(
        /state=loaded attempts=1 failures=0 killed=0 killedAfterSuccess=1 notExitedAfterKill=1 added=0 blocked=0 ms=\d+$/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a group signal refused with EPERM is never taken for a group that is gone: SIGKILL still follows, and the member that could not be signalled is counted (killedAfterSuccess + notExitedAfterKill)", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new FakeChild(), { pid: 900_012 });
      // A member exists but cannot be signalled — every signal to the group, and the liveness probe, is refused.
      killSpy.mockImplementation(((pid: number) => {
        if (pid === -900_012) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }) as typeof process.kill);
      spawnMock.mockReturnValueOnce(child).mockImplementation(() => new FakeChild());
      const m = await import("../../../electron/path-bootstrap");
      const { probeSettled } = withPlatform("darwin", () => m.bootstrapPath());
      child.stdout.emit(
        "data",
        Buffer.from(`${m.ENV_START_MARKER}${envBody({ PATH: "/eperm/bin:/usr/bin" })}${m.ENV_END_MARKER}`),
      );
      child.emit("exit", 0, null); // the shell itself exited; its group did not empty
      await vi.advanceTimersByTimeAsync(0);
      expect(process.env.LIBI_SHELL_ENV).toBe("loaded");
      expect(killSpy).toHaveBeenCalledWith(-900_012, "SIGTERM");
      await vi.advanceTimersByTimeAsync(m.SHELL_PROBE_KILL_GRACE_MS);
      expect(killSpy).toHaveBeenCalledWith(-900_012, "SIGKILL");
      await vi.advanceTimersByTimeAsync(m.SHELL_PROBE_EXIT_WAIT_MS);
      await probeSettled;
      expect(logLines.find((l) => l.includes("shell_env_probe_done"))).toMatch(
        /state=loaded attempts=1 failures=0 killed=0 killedAfterSuccess=1 notExitedAfterKill=1 added=0 blocked=0 ms=\d+$/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a group member that survives SIGKILL after the shell has exited is counted (notExitedAfterKill), and waited for no longer than the exit wait", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new FakeChild(), { pid: 900_013 });
      // The shell exits; a background job in its group is still there after SIGKILL, for good.
      killSpy.mockImplementation(((pid: number) => {
        if (pid === -900_013) return true;
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }) as typeof process.kill);
      spawnMock.mockReturnValueOnce(child).mockImplementation(() => new FakeChild());
      const m = await import("../../../electron/path-bootstrap");
      const { probeSettled } = withPlatform("darwin", () => m.bootstrapPath());
      let settledAt: number | null = null;
      void probeSettled.then(() => {
        settledAt = Date.now();
      });
      child.stdout.emit(
        "data",
        Buffer.from(`${m.ENV_START_MARKER}${envBody({ PATH: "/survivor/bin:/usr/bin" })}${m.ENV_END_MARKER}`),
      );
      child.emit("exit", 0, null);
      const capturedAt = Date.now();
      await vi.advanceTimersByTimeAsync(m.SHELL_PROBE_KILL_GRACE_MS);
      expect(killSpy).toHaveBeenCalledWith(-900_013, "SIGKILL");
      expect(killSpy).toHaveBeenCalledWith(-900_013, 0); // the group, not only the shell, is checked
      await vi.advanceTimersByTimeAsync(m.SHELL_PROBE_EXIT_WAIT_MS);
      await probeSettled;
      expect(settledAt! - capturedAt).toBe(m.SHELL_PROBE_KILL_GRACE_MS + m.SHELL_PROBE_EXIT_WAIT_MS);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(logLines.find((l) => l.includes("shell_env_probe_done"))).toMatch(
        /state=loaded attempts=1 failures=0 killed=0 killedAfterSuccess=1 notExitedAfterKill=1 added=0 blocked=0 ms=\d+$/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a timed-out attempt whose shell dies of SIGKILL but whose group keeps a member reports exited=false, and the next attempt still starts once the exit wait is up", async () => {
    vi.useFakeTimers();
    try {
      const first = Object.assign(new FakeChild(), { pid: 900_014 });
      killSpy.mockImplementation(((pid: number, signal?: string | number) => {
        if (pid === -900_014) {
          if (signal === "SIGKILL") void Promise.resolve().then(() => first.emit("exit", null, "SIGKILL"));
          return true;
        }
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }) as typeof process.kill);
      spawnMock.mockReturnValueOnce(first).mockImplementation(() => new FakeChild());
      const m = await import("../../../electron/path-bootstrap");
      withPlatform("darwin", () => m.bootstrapPath());
      await vi.advanceTimersByTimeAsync(m.SHELL_PROBE_TIMEOUT_MS + m.SHELL_PROBE_KILL_GRACE_MS);
      expect(killSpy).toHaveBeenCalledWith(-900_014, "SIGKILL");
      await vi.advanceTimersByTimeAsync(m.SHELL_PROBE_EXIT_WAIT_MS + m.SHELL_PROBE_BACKOFF_MS[0] - 1);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(logLines.find((l) => l.includes("shell_env_probe_attempt_failed"))).toMatch(
        /attempt=1 cause=timeout pathApplied=false exited=false$/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a SIGKILLed member still being reaped is not a survivor: the group is re-checked within the exit wait, and one that empties (EPERM from a macOS zombie-only group, then ESRCH) counts nothing", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new FakeChild(), { pid: 900_015 });
      let probes = 0;
      killSpy.mockImplementation(((pid: number, signal?: string | number) => {
        if (pid !== -900_015) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
        if (signal !== 0) return true;
        // macOS answers EPERM for a group whose only member is an unreaped zombie.
        if (++probes <= 2) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }) as typeof process.kill);
      spawnMock.mockReturnValueOnce(child).mockImplementation(() => new FakeChild());
      const m = await import("../../../electron/path-bootstrap");
      const { probeSettled } = withPlatform("darwin", () => m.bootstrapPath());
      child.stdout.emit(
        "data",
        Buffer.from(`${m.ENV_START_MARKER}${envBody({ PATH: "/reaped/bin:/usr/bin" })}${m.ENV_END_MARKER}`),
      );
      child.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(m.SHELL_PROBE_KILL_GRACE_MS + m.SHELL_PROBE_EXIT_WAIT_MS);
      await probeSettled;
      expect(probes).toBe(3);
      expect(logLines.find((l) => l.includes("shell_env_probe_done"))).toMatch(
        /state=loaded attempts=1 failures=0 killed=0 killedAfterSuccess=1 notExitedAfterKill=0 added=0 blocked=0 ms=\d+$/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("our end of the child's stdout is destroyed once an attempt settles — after a timeout, an incomplete capture, a spawn error, and a success whose pipe stays open", async () => {
    vi.useFakeTimers();
    try {
      const m = await import("../../../electron/path-bootstrap");
      const timedOut = Object.assign(new FakeChild(), { pid: 900_016 });
      const incomplete = closesIncomplete();
      const errored = new FakeChild();
      const succeeded = new FakeChild();
      spawnMock
        .mockReturnValueOnce(timedOut)
        .mockReturnValueOnce(incomplete)
        .mockImplementationOnce(() => {
          // Emitted only once spawn has returned, so the probe's `error` listener is attached.
          void Promise.resolve().then(() =>
            errored.emit("error", Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" })),
          );
          return errored;
        })
        .mockImplementationOnce(() => {
          void Promise.resolve().then(() =>
            succeeded.stdout.emit(
              "data",
              Buffer.from(`${m.ENV_START_MARKER}${envBody({ PATH: "/open/bin:/usr/bin" })}${m.ENV_END_MARKER}`),
            ),
          ); // …and never `close`
          return succeeded;
        });
      const { probeSettled } = withPlatform("darwin", () => m.bootstrapPath());
      await vi.advanceTimersByTimeAsync(m.SHELL_PROBE_TIMEOUT_MS);
      expect(timedOut.stdout.destroy).toHaveBeenCalled();
      timedOut.emit("exit", null, "SIGTERM");
      await vi.advanceTimersByTimeAsync(60_000);
      await probeSettled;
      expect(spawnMock).toHaveBeenCalledTimes(4);
      expect(process.env.LIBI_SHELL_ENV).toBe("loaded");
      expect(incomplete.stdout.destroy).toHaveBeenCalled();
      // The third attempt really took the spawn-error path, not a timeout.
      expect(logLines.filter((l) => l.includes("shell_env_probe_attempt_failed"))[2]).toMatch(
        /attempt=3 cause=error code=EAGAIN$/,
      );
      expect(errored.stdout.destroy).toHaveBeenCalled();
      expect(succeeded.stdout.destroy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a SIGTERM that finds the group already gone (ESRCH) counts nothing and waits for nothing", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new FakeChild(), { pid: 900_009 });
      killSpy.mockImplementation((() => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }) as typeof process.kill);
      spawnMock.mockReturnValueOnce(child).mockImplementation(() => new FakeChild());
      const m = await import("../../../electron/path-bootstrap");
      const { probeSettled } = withPlatform("darwin", () => m.bootstrapPath());
      let probeDone = false;
      void probeSettled.then(() => {
        probeDone = true;
      });
      child.stdout.emit(
        "data",
        Buffer.from(`${m.ENV_START_MARKER}${envBody({ PATH: "/gone/bin:/usr/bin" })}${m.ENV_END_MARKER}`),
      );
      await vi.advanceTimersByTimeAsync(m.SHELL_PROBE_EXIT_CHANCE_MS);
      expect(killSpy).toHaveBeenCalledWith(-900_009, "SIGTERM");
      expect(probeDone).toBe(true); // settled at the SIGTERM: no grace, no exit wait
      await vi.advanceTimersByTimeAsync(60_000);
      expect(killSpy).not.toHaveBeenCalledWith(-900_009, "SIGKILL");
      expect(logLines.find((l) => l.includes("shell_env_probe_done"))).toMatch(
        /state=loaded attempts=1 failures=0 killed=0 killedAfterSuccess=0 notExitedAfterKill=0 added=0 blocked=0 ms=\d+$/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("stopShellEnvProbe() while a succeeded attempt's group termination is still running: the loop logs nothing once it settles", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new FakeChild(), { pid: 900_010 });
      killSpy.mockImplementation((() => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }) as typeof process.kill);
      spawnMock.mockReturnValueOnce(child).mockImplementation(() => new FakeChild());
      const m = await import("../../../electron/path-bootstrap");
      withPlatform("darwin", () => m.bootstrapPath());
      child.stdout.emit(
        "data",
        Buffer.from(`${m.ENV_START_MARKER}${envBody({ PATH: "/stop/bin:/usr/bin" })}${m.ENV_END_MARKER}`),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(process.env.LIBI_SHELL_ENV).toBe("loaded"); // the loop now awaits the termination
      m.stopShellEnvProbe();
      child.emit("exit", 0, null); // …which settles only after the stop
      await vi.advanceTimersByTimeAsync(60_000);
      expect(killSpy).toHaveBeenCalledWith(-900_010, "SIGTERM"); // the termination did run to its end
      expect(logLines.some((l) => l.includes("shell_env_probe_done"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an early close with an incomplete capture still terminates the attempt's group — a profile's `daemon >/dev/null &` does not survive the attempt — and counts as `killed`; a group already gone counts nothing", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new FakeChild(), { pid: 900_005 });
      // The first attempt's group still holds the daemon; every later attempt's group is gone (ESRCH).
      killSpy.mockImplementation(((pid: number, signal?: string | number) => {
        // The daemon is reachable until the SIGKILL, which ends it: the probe after that finds nothing.
        if (pid === -900_005 && signal !== 0) return true;
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }) as typeof process.kill);
      spawnMock
        .mockReturnValueOnce(child)
        .mockImplementation(() => Object.assign(closesIncomplete(), { pid: 900_006 }));
      const m = await import("../../../electron/path-bootstrap");
      const { probeSettled } = withPlatform("darwin", () => m.bootstrapPath());
      child.stdout.emit("data", Buffer.from(`${m.ENV_START_MARKER}PATH=/p\0`));
      child.emit("exit", 0, null); // the shell exited without printing the end marker
      child.emit("close", 0);
      await vi.advanceTimersByTimeAsync(0);
      expect(killSpy).toHaveBeenCalledWith(-900_005, "SIGTERM");
      await vi.advanceTimersByTimeAsync(m.SHELL_PROBE_KILL_GRACE_MS - 1);
      expect(killSpy).not.toHaveBeenCalledWith(-900_005, "SIGKILL");
      expect(spawnMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(killSpy).toHaveBeenCalledWith(-900_005, "SIGKILL");
      // The shell had already exited, so there is no exit wait: the backoff starts at the SIGKILL.
      await vi.advanceTimersByTimeAsync(m.SHELL_PROBE_BACKOFF_MS[0] - 1);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      await probeSettled;
      expect(process.env.LIBI_SHELL_ENV).toBe("failed");
      expect(process.env.PATH!.split(":")).not.toContain("/p");
      const failed = logLines.filter((l) => l.includes("shell_env_probe_attempt_failed"));
      expect(failed[0]).toMatch(/attempt=1 cause=incomplete killed=true exited=true$/);
      expect(failed[1]).toMatch(/attempt=2 cause=incomplete$/);
      expect(logLines.find((l) => l.includes("shell_env_probe_done"))).toMatch(
        /state=failed attempts=5 failures=5 killed=1 killedAfterSuccess=0 notExitedAfterKill=0 added=0 blocked=0 ms=\d+$/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a complete frame with no PATH entry is not a success: an empty frame (`env -0` unsupported), NUL-less output (`env` aliased) and a frame without PATH each fail as incomplete and apply nothing", async () => {
    vi.useFakeTimers();
    try {
      const m = await import("../../../electron/path-bootstrap");
      const framed = (body: string) => (): FakeChild => {
        const child = new FakeChild();
        void Promise.resolve().then(() => {
          child.stdout.emit("data", Buffer.from(`${m.ENV_START_MARKER}${body}${m.ENV_END_MARKER}`));
          child.emit("exit", 0, null);
          child.emit("close", 0);
        });
        return child;
      };
      spawnMock
        .mockImplementationOnce(framed(""))
        .mockImplementationOnce(framed("PATH=/aliased/bin\nLATE_VAR=v\n"))
        .mockImplementationOnce(framed(envBody({ LATE_VAR: "no-path" })))
        .mockImplementation(() => closesIncomplete());
      const { probeSettled } = withPlatform("darwin", () => m.bootstrapPath());
      await vi.advanceTimersByTimeAsync(60_000);
      await probeSettled;
      expect(spawnMock).toHaveBeenCalledTimes(5);
      expect(process.env.LIBI_SHELL_ENV).toBe("failed");
      expect(process.env.LATE_VAR).toBeUndefined();
      expect(process.env.PATH!.split(":")).not.toContain("/aliased/bin");
      expect(existsSync(cacheFile())).toBe(false);
      const failed = logLines.filter((l) => l.includes("shell_env_probe_attempt_failed"));
      expect(failed).toHaveLength(5);
      for (const [i, line] of failed.slice(0, 3).entries()) {
        expect(line).toMatch(new RegExp(`attempt=${i + 1} cause=incomplete$`));
      }
      expect(logLines.find((l) => l.includes("shell_env_probe_done"))).toMatch(
        /state=failed attempts=5 failures=5 killed=0 killedAfterSuccess=0 notExitedAfterKill=0 added=0 blocked=0 ms=\d+$/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a timed-out attempt: SIGTERM to its process group, SIGKILL 500 ms later, and the next attempt starts only after its `exit`", async () => {
    vi.useFakeTimers();
    try {
      const first = Object.assign(new FakeChild(), { pid: 900_001 });
      spawnMock.mockReturnValueOnce(first).mockImplementation(() => new FakeChild());
      const { bootstrapPath, SHELL_PROBE_TIMEOUT_MS, SHELL_PROBE_KILL_GRACE_MS, SHELL_PROBE_EXIT_WAIT_MS, SHELL_PROBE_BACKOFF_MS } =
        await import("../../../electron/path-bootstrap");
      withPlatform("darwin", () => bootstrapPath());
      await vi.advanceTimersByTimeAsync(SHELL_PROBE_TIMEOUT_MS);
      expect(killSpy).toHaveBeenCalledWith(-900_001, "SIGTERM");
      await vi.advanceTimersByTimeAsync(SHELL_PROBE_KILL_GRACE_MS - 1);
      expect(killSpy).not.toHaveBeenCalledWith(-900_001, "SIGKILL");
      await vi.advanceTimersByTimeAsync(1);
      expect(killSpy).toHaveBeenCalledWith(-900_001, "SIGKILL");
      // Still no `exit`: no second attempt, however long the backoff would have been.
      await vi.advanceTimersByTimeAsync(SHELL_PROBE_EXIT_WAIT_MS - 1);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      first.emit("exit", null, "SIGKILL");
      await vi.advanceTimersByTimeAsync(SHELL_PROBE_BACKOFF_MS[0] - 1);
      expect(spawnMock).toHaveBeenCalledTimes(1); // the 1 s backoff starts at the exit
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(logLines.find((l) => l.includes("shell_env_probe_attempt_failed"))).toMatch(
        /attempt=1 cause=timeout pathApplied=false exited=true$/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("an attempt that survives SIGKILL is counted (notExitedAfterKill) and blocks nothing", async () => {
    vi.useFakeTimers();
    try {
      // Never exits, never closes — the TCC-blocked shell, as far as a fake can be.
      spawnMock.mockImplementation(() => Object.assign(new FakeChild(), { pid: 900_002 }));
      const m = await import("../../../electron/path-bootstrap");
      const { probeSettled } = withPlatform("darwin", () => m.bootstrapPath());
      const perAttempt = m.SHELL_PROBE_TIMEOUT_MS + m.SHELL_PROBE_KILL_GRACE_MS + m.SHELL_PROBE_EXIT_WAIT_MS;
      await vi.advanceTimersByTimeAsync(perAttempt);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(m.SHELL_PROBE_BACKOFF_MS[0]);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5 * perAttempt + 15_000);
      await probeSettled;
      expect(process.env.LIBI_SHELL_ENV).toBe("failed");
      expect(logLines.find((l) => l.includes("shell_env_probe_done"))).toMatch(
        /state=failed attempts=5 failures=5 killed=5 killedAfterSuccess=0 notExitedAfterKill=5 added=0 blocked=0 ms=\d+$/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second bootstrapPath() joins the running probe instead of starting another", async () => {
    spawnMock.mockReturnValue(new FakeChild());
    const { bootstrapPath } = await import("../../../electron/path-bootstrap");
    const first = withPlatform("darwin", () => bootstrapPath());
    const second = withPlatform("darwin", () => bootstrapPath());
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(second.probeSettled).toBe(first.probeSettled);
  });
});

describe("bootstrapPath — PATH cache (a warm launch still probes)", () => {
  it("applies a cache hit synchronously AND still runs the probe", async () => {
    mkdirSync(libiHome, { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify({ shell: "/bin/zsh", path: "/cached/bin:/usr/bin" }));
    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);
    const { bootstrapPath } = await import("../../../electron/path-bootstrap");
    withPlatform("darwin", () => bootstrapPath());
    expect(process.env.PATH!.split(":")).toContain("/cached/bin");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("a cache written for a different $SHELL is ignored (falls back + probes)", async () => {
    mkdirSync(libiHome, { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify({ shell: "/bin/bash", path: "/cached/bin" }));
    spawnMock.mockReturnValue(new FakeChild());
    const { bootstrapPath } = await import("../../../electron/path-bootstrap");
    withPlatform("darwin", () => bootstrapPath());
    expect(process.env.PATH!.split(":")).not.toContain("/cached/bin");
    expect(process.env.PATH!.split(":")).toContain("/opt/homebrew/bin");
  });

  it("a corrupt cache file degrades cleanly, never throws", async () => {
    mkdirSync(libiHome, { recursive: true });
    writeFileSync(cacheFile(), "{not json");
    spawnMock.mockReturnValue(new FakeChild());
    const { bootstrapPath } = await import("../../../electron/path-bootstrap");
    expect(() => withPlatform("darwin", () => bootstrapPath())).not.toThrow();
  });
});

describe("bootstrapPath — win32", () => {
  it("applies the win32 fallback locations, never probes a shell, leaves LIBI_SHELL_ENV absent (inherited), and probeSettled is already resolved", async () => {
    process.env.USERPROFILE = "C:\\Users\\test";
    process.env.PATH = "C:\\Windows";
    const { bootstrapPath } = await import("../../../electron/path-bootstrap");
    const { probeSettled } = withPlatform("win32", () => bootstrapPath());
    expect(spawnMock).not.toHaveBeenCalled();
    expect(process.env.LIBI_SHELL_ENV).toBeUndefined();
    await expect(probeSettled).resolves.toBeUndefined();
  });
});
