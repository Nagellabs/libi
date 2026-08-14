import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `electron/path-bootstrap.ts` must never let boot depend on the OS
 * answering a login-shell PATH probe. See its docblock and
 * `.superpowers/sdd/boot-hang-investigation.md` for the real incident this
 * guards against: a spawned `/bin/zsh` parked inside a macOS TCC/sandbox
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

/** A fake ChildProcess good enough for path-bootstrap's needs. */
class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { unref: vi.fn() });
  unref = vi.fn();
  kill = vi.fn();
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

beforeEach(() => {
  envSnapshot = { ...process.env };
  libiHome = mkdtempSync(path.join(tmpdir(), "libi-path-bootstrap-"));
  process.env.LIBI_HOME = libiHome;
  process.env.HOME = "/Users/testuser";
  process.env.SHELL = "/bin/zsh";
  process.env.PATH = "/usr/bin:/bin";
  spawnMock.mockReset();
  execSyncMock.mockClear();
});

afterEach(() => {
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

describe("bootstrapPath — background probe result (when it does arrive)", () => {
  it("applies the discovered PATH late and writes the cache once the probe succeeds", async () => {
    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const { bootstrapPath } = await import("../../../electron/path-bootstrap");
    withPlatform("darwin", () => bootstrapPath());

    // Fallback is already applied and usable at this point.
    expect(process.env.PATH ?? "").not.toContain("/opt/discovered/bin");

    // Now the probe "answers" — simulate the shell replying.
    fakeChild.stdout.emit("data", Buffer.from("/opt/discovered/bin:/usr/bin"));
    fakeChild.emit("close", 0);

    const finalPath = process.env.PATH ?? "";
    expect(finalPath).toContain("/opt/discovered/bin");

    expect(existsSync(cacheFile())).toBe(true);
    const cached = JSON.parse(readFileSync(cacheFile(), "utf8"));
    expect(cached).toEqual({ shell: "/bin/zsh", path: "/opt/discovered/bin:/usr/bin" });
  });

  it("does not apply or cache anything when the probe reports an error", async () => {
    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const { bootstrapPath } = await import("../../../electron/path-bootstrap");
    withPlatform("darwin", () => bootstrapPath());

    fakeChild.emit("error", new Error("ENOENT"));

    expect(existsSync(cacheFile())).toBe(false);
    expect(process.env.PATH ?? "").not.toContain("/opt/discovered/bin");
  });

  it("applies and caches already-buffered stdout on the timeout path instead of discarding it", async () => {
    vi.useFakeTimers();
    try {
      const fakeChild = new FakeChild();
      spawnMock.mockReturnValue(fakeChild);

      const { bootstrapPath } = await import("../../../electron/path-bootstrap");
      withPlatform("darwin", () => bootstrapPath());

      // The shell printed a full, usable PATH, but something (a backgrounded
      // rc-file job) is holding the pipe open, so "close" never fires.
      fakeChild.stdout.emit("data", Buffer.from("/opt/discovered/bin:/usr/bin"));

      // Advance past the 2s guard timer without ever emitting "close".
      await vi.advanceTimersByTimeAsync(2001);

      const finalPath = process.env.PATH ?? "";
      expect(finalPath).toContain("/opt/discovered/bin");
      expect(existsSync(cacheFile())).toBe(true);
      const cached = JSON.parse(readFileSync(cacheFile(), "utf8"));
      expect(cached).toEqual({ shell: "/bin/zsh", path: "/opt/discovered/bin:/usr/bin" });
      // The timeout path still best-effort kills the (evidently stuck) child.
      expect(fakeChild.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects probe output containing a newline instead of caching rc-file banner noise", async () => {
    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const { bootstrapPath } = await import("../../../electron/path-bootstrap");
    withPlatform("darwin", () => bootstrapPath());

    // `-ilc` runs the shell interactively — an oh-my-zsh update banner (or
    // similar) ahead of the PATH line is exactly the shape this must reject.
    fakeChild.stdout.emit(
      "data",
      Buffer.from("zsh: update available!\n/opt/discovered/bin:/usr/bin"),
    );
    fakeChild.emit("close", 0);

    expect(existsSync(cacheFile())).toBe(false);
    expect(process.env.PATH ?? "").not.toContain("/opt/discovered/bin");
  });

  it("brackets the probe with self-diagnosing shell_path_probe_start/_done log lines", async () => {
    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const { bootstrapPath } = await import("../../../electron/path-bootstrap");
    withPlatform("darwin", () => bootstrapPath());

    fakeChild.stdout.emit("data", Buffer.from("/opt/discovered/bin:/usr/bin"));
    fakeChild.emit("close", 0);

    const logPath = path.join(libiHome, "logs", "electron-main-sync.log");
    expect(existsSync(logPath)).toBe(true);
    const logContents = readFileSync(logPath, "utf8");
    expect(logContents).toContain("shell_path_probe_start");
    expect(logContents).toContain("shell_path_probe_done");
  });

  it("logs shell_path_probe_timeout when the guard timer fires before close/error", async () => {
    vi.useFakeTimers();
    try {
      const fakeChild = new FakeChild();
      spawnMock.mockReturnValue(fakeChild);

      const { bootstrapPath } = await import("../../../electron/path-bootstrap");
      withPlatform("darwin", () => bootstrapPath());

      await vi.advanceTimersByTimeAsync(2001);

      const logPath = path.join(libiHome, "logs", "electron-main-sync.log");
      expect(existsSync(logPath)).toBe(true);
      const logContents = readFileSync(logPath, "utf8");
      expect(logContents).toContain("shell_path_probe_start");
      expect(logContents).toContain("shell_path_probe_timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("bootstrapPath — PATH cache", () => {
  it("a cache hit is applied synchronously and skips the probe entirely", async () => {
    writeFileSync(
      cacheFile(),
      JSON.stringify({ shell: "/bin/zsh", path: "/opt/cached/bin:/usr/bin" }),
    );

    const { bootstrapPath } = await import("../../../electron/path-bootstrap");
    withPlatform("darwin", () => bootstrapPath());

    expect(process.env.PATH ?? "").toContain("/opt/cached/bin");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("a cache written for a different $SHELL is ignored (falls back + re-probes)", async () => {
    writeFileSync(
      cacheFile(),
      JSON.stringify({ shell: "/bin/bash", path: "/opt/cached/bin:/usr/bin" }),
    );
    process.env.SHELL = "/bin/zsh";

    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const { bootstrapPath } = await import("../../../electron/path-bootstrap");
    withPlatform("darwin", () => bootstrapPath());

    expect(process.env.PATH ?? "").not.toContain("/opt/cached/bin");
    expect(process.env.PATH ?? "").toContain("/opt/homebrew/bin");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("a corrupt cache file degrades cleanly to the fallback + re-probe, never throws", async () => {
    mkdirSync(path.dirname(cacheFile()), { recursive: true });
    writeFileSync(cacheFile(), "{ not valid json");

    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const { bootstrapPath } = await import("../../../electron/path-bootstrap");
    expect(() => withPlatform("darwin", () => bootstrapPath())).not.toThrow();

    expect(process.env.PATH ?? "").toContain("/opt/homebrew/bin");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("an absent cache file degrades cleanly to the fallback + re-probe", async () => {
    expect(existsSync(cacheFile())).toBe(false);

    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const { bootstrapPath } = await import("../../../electron/path-bootstrap");
    withPlatform("darwin", () => bootstrapPath());

    expect(process.env.PATH ?? "").toContain("/opt/homebrew/bin");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("bootstrapPath — win32", () => {
  it("applies the win32 fallback locations and never probes a shell", async () => {
    const originalUserProfile = process.env.USERPROFILE;
    process.env.USERPROFILE = "C:\\Users\\testuser";

    const { bootstrapPath } = await import("../../../electron/path-bootstrap");
    withPlatform("win32", () => bootstrapPath());

    expect(process.env.PATH ?? "").toContain("nodejs");
    expect(spawnMock).not.toHaveBeenCalled();

    process.env.USERPROFILE = originalUserProfile;
  });
});
