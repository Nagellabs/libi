import { describe, expect, it, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(tmpdir(), "libi-home-"));
const agentsRoot = path.join(home, "agents");
const adapterBin = path.join(agentsRoot, "node_modules", ".bin", "claude-agent-acp");

/**
 * Which home this suite resolves against. Mutable so a test that drives the
 * REAL cross-process install lock can point at a root nothing else touches:
 * the lock judges a holder alive when its pid is alive, and the test process
 * IS that pid, so one leftover `.agent-install.lock` in a shared root is
 * never stale and the acquire poll runs to its (30+ min) timeout — a
 * hang-shaped failure that only reproduces when a previous run left the file
 * behind.
 *
 * `setCurrentHome` writes BOTH `currentHome` (read by this file's own path
 * helpers) AND `process.env.LIBI_HOME` — not just one. A prior version of
 * this file only overrode the `getLibiHome` export via `vi.mock`, which
 * `runtime-install.ts`'s own `getLibiHome()` calls honoured, but which
 * `ensureLibiDirs()` / `getLibiLogDir()` do NOT: those run as an IMPORT-TIME
 * side effect inside `@/lib/logger` (transitively pulled in by
 * `@/lib/agents/runtime-install`), and call the REAL, un-mocked
 * `getLibiHome()` from within `lib/libi-home.ts`'s own module scope — a
 * direct intra-module call the `vi.mock` override on the exported binding
 * cannot see. That real `getLibiHome()` reads `process.env.LIBI_HOME`
 * directly, which `__tests__/setup/isolate-libi-home.ts` sets ONCE, globally,
 * for the entire `npm test` run — shared by every one of the suite's ~1100
 * other test files. Every dynamic import in this file after a
 * `vi.resetModules()` (there are more than a dozen) was therefore quietly
 * re-creating dirs and appending log lines to that ONE shared, heavily
 * contended `logs/libi.log` under full-suite parallel load — synchronous
 * `fs` calls (mkdir/chmod/stat/truncate) on a hot shared file/dir tree can
 * stall the event loop long enough to blow a tight default test timeout.
 * Worse, when that happened to the "derives lock staleness" test (5s
 * default timeout, real un-mocked `acquireInstallLock`), vitest does not
 * cancel the still in-flight promise — its dangling lock/install work then
 * raced this test's own `afterEach` cleanup of `currentHome`, producing a
 * SECOND failure (`ENOTEMPTY`) for the same test on the same run.
 *
 * Routing `process.env.LIBI_HOME` itself through `currentHome` — the same
 * technique `__tests__/unit/logger-home-routing.test.ts` and dozens of other
 * suites already use — makes every code path (this file's own `getLibiHome`
 * calls AND the transitive `ensureLibiDirs`/logger calls) agree on the same
 * private, uncontended directory, so this suite never touches the shared
 * global LIBI_HOME at all.
 */
let currentHome = home;
const originalLibiHome = process.env.LIBI_HOME;

function setCurrentHome(dir: string): void {
  currentHome = dir;
  process.env.LIBI_HOME = dir;
}

setCurrentHome(home);

afterAll(() => {
  if (originalLibiHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = originalLibiHome;
});

/** An empty directory standing in for a NON-dev checkout (no repo-local bin). */
function makeEmptyRepoRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "libi-norepo-"));
}

function seedExecutable(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, 0o755);
}

/**
 * What a PARTIAL `npm install` leaves on disk: the ~40KB adapter landed and
 * matches the pin, but @anthropic-ai/claude-agent-sdk's ~212MB platform
 * package (an optionalDependency — npm exits 0 when it fails) did not.
 */
function simulatePartialAdapterInstall(root: string, version: string): void {
  const pkgDir = path.join(root, "node_modules", "@agentclientprotocol", "claude-agent-acp");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ version }));
  seedExecutable(path.join(root, "node_modules", ".bin", "claude-agent-acp"));
}

/** The platform package holding the native CLI binary this runtime needs. */
function seedNativeBinary(root: string): void {
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const file = process.platform === "win32" ? "claude.exe" : "claude";
  seedExecutable(path.join(root, "node_modules", ...pkg.split("/"), file));
}

/** What a real, COMPLETE `npm install` of the adapter leaves on disk. */
function simulateSuccessfulAdapterInstall(root: string, version: string): void {
  simulatePartialAdapterInstall(root, version);
  seedNativeBinary(root);
}

/** Run `fn` with `process.platform` faked — the only way to test cmd-shim handling off-Windows. */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

/**
 * Capture the structured records this module logs, for the tests that assert
 * on them.
 *
 * Two of those records are the ONLY evidence of their event anywhere: the
 * `claude_adapter_repair` warn (with its `reason`) is how a drift-triggered
 * reinstall is greppable in ~/.libi/logs/libi.log at all, and
 * `claude_adapter_upgrade_failed_stale_kept` is the only signal that an
 * upgrade failed and the old tree was kept — the returned value is otherwise
 * `installed: true`, and a boot on which the rollout reached nobody looks
 * exactly like one on which it reached everybody. Both were deletable with
 * this whole suite still green until these assertions existed.
 *
 * Must be called BEFORE the dynamic `import()` of the module under test, and
 * paired with `vi.doUnmock("@/lib/logger")` in `afterEach`.
 */
type LogRecord = Record<string, unknown>;
function captureLogs(): LogRecord[] {
  const records: LogRecord[] = [];
  const sink = (obj: unknown) => {
    if (obj && typeof obj === "object") records.push(obj as LogRecord);
  };
  const fake = { info: sink, warn: sink, error: sink, debug: sink, child: () => fake };
  vi.doMock("@/lib/logger", () => ({
    serverLogger: fake,
    mcpLogger: fake,
    ffmpegLogger: fake,
    mediabunnyLogger: fake,
    proxyLogger: fake,
    exportLogger: fake,
    overlayLogger: fake,
    scriptAnalysisLogger: fake,
  }));
  return records;
}

describe("resolveInstalledAdapterBin", () => {
  afterEach(() => rmSync(agentsRoot, { recursive: true, force: true }));

  it("returns null when the adapter is not installed", async () => {
    const { resolveInstalledAdapterBin } = await import("@/lib/agents/runtime-install");
    expect(resolveInstalledAdapterBin()).toBeNull();
  });

  it("resolves under the DEDICATED agent root (~/.libi/agents), not the bundled-MCP root", async () => {
    seedExecutable(adapterBin);

    const { resolveInstalledAdapterBin, getAgentInstallRoot } = await import(
      "@/lib/agents/runtime-install"
    );
    expect(getAgentInstallRoot()).toBe(agentsRoot);
    expect(resolveInstalledAdapterBin()).toBe(adapterBin);
  });

  it("ignores a bin sitting in the bundled-MCP root (~/.libi/node_modules)", async () => {
    seedExecutable(path.join(home, "node_modules", ".bin", "claude-agent-acp"));

    const { resolveInstalledAdapterBin } = await import("@/lib/agents/runtime-install");
    expect(resolveInstalledAdapterBin()).toBeNull();

    rmSync(path.join(home, "node_modules"), { recursive: true, force: true });
  });

  it("pins the adapter to an exact version, never a range", async () => {
    const { CLAUDE_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-install");
    expect(CLAUDE_ADAPTER_PACKAGE.npmPackage).toBe("@agentclientprotocol/claude-agent-acp");
    expect(CLAUDE_ADAPTER_PACKAGE.pinnedVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("ensureClaudeAdapterInstalled", () => {
  let repoRoot: string;

  beforeEach(() => {
    vi.resetModules();
    repoRoot = makeEmptyRepoRoot();
    // A developer machine may point this at a real Claude Code binary, which
    // the adapter (and therefore libi's health check) honours above any
    // platform package — that would make every "native binary missing" case
    // below silently pass. Empty string is falsy, so the override is ignored.
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "");
  });

  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    // `maxRetries` because `force` does NOT cover ENOTEMPTY: if a test above
    // ever times out mid-install, its still in-flight work can be writing into
    // this tree while we delete it, and the raw `rmSync` then throws a second
    // failure attributed to CLEANUP — hiding the real one. Cleanup must never
    // be able to invent a failure of its own.
    if (currentHome !== home) {
      rmSync(currentHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    setCurrentHome(home);
    vi.unstubAllEnvs();
    vi.doUnmock("node:child_process");
    vi.doUnmock("@/lib/install/npm-root");
  });

  it("short-circuits without installing when the tree is complete AND matches the pin", async () => {
    const { CLAUDE_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    simulateSuccessfulAdapterInstall(agentsRoot, CLAUDE_ADAPTER_PACKAGE.pinnedVersion);

    const execFile = vi.fn();
    vi.doMock("node:child_process", () => ({ execFile }));

    const { ensureClaudeAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureClaudeAdapterInstalled({ repoRoot });

    expect(result).toEqual({ installed: true, binPath: adapterBin });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("skips the install entirely in a dev checkout that already has a repo-local adapter bin", async () => {
    const repoBin = path.join(repoRoot, "node_modules", ".bin", "claude-agent-acp");
    seedExecutable(repoBin);

    const execFile = vi.fn();
    vi.doMock("node:child_process", () => ({ execFile }));

    const { ensureClaudeAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureClaudeAdapterInstalled({ repoRoot });

    expect(result).toEqual({ installed: true, binPath: repoBin });
    expect(execFile).not.toHaveBeenCalled();
    // Nothing was downloaded into the (cold) agent root.
    expect(existsSync(agentsRoot)).toBe(false);
  });

  it("prefers the repo-local adapter bin over an already-installed agent-root bin", async () => {
    // Simulates a developer whose ~/.libi was previously populated by a
    // production run: BOTH bins exist. The Global Constraint is that
    // node_modules/.bin/claude-agent-acp in the repo must always win, so the
    // checkout's own code runs instead of silently falling back to whatever
    // version got installed into the agent root.
    const repoBin = path.join(repoRoot, "node_modules", ".bin", "claude-agent-acp");
    seedExecutable(repoBin);
    seedExecutable(adapterBin);

    const execFile = vi.fn();
    vi.doMock("node:child_process", () => ({ execFile }));

    const { ensureClaudeAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureClaudeAdapterInstalled({ repoRoot });

    expect(result).toEqual({ installed: true, binPath: repoBin });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("defaults repoRoot to process.cwd() so the running dev checkout is detected", async () => {
    // This repo IS a dev checkout: node_modules/.bin/claude-agent-acp exists.
    const execFile = vi.fn();
    vi.doMock("node:child_process", () => ({ execFile }));

    const { ensureClaudeAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureClaudeAdapterInstalled();

    expect(result.installed).toBe(true);
    expect(result.binPath).toBe(
      path.join(process.cwd(), "node_modules", ".bin", "claude-agent-acp"),
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  it("installs into the agent root and resolves the bin once it lands", async () => {
    let capturedArgs: string[] | null = null;
    const { CLAUDE_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
      ) => {
        capturedArgs = args;
        simulateSuccessfulAdapterInstall(agentsRoot, CLAUDE_ADAPTER_PACKAGE.pinnedVersion);
        cb(null, { stdout: "", stderr: "" });
      },
    }));

    const { ensureClaudeAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureClaudeAdapterInstalled({ repoRoot });

    expect(result).toEqual({ installed: true, binPath: adapterBin });
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs!).toContain("--ignore-scripts");
    // Installed into the DEDICATED agent root, not the bundled-MCP root.
    expect(capturedArgs!).toContain(agentsRoot);
    expect(capturedArgs!).not.toContain(home);

    // The generated manifest lives in the agent root and lists ONLY the agent
    // packages — bundled MCPs are a separate root, separate npm install.
    const manifest = JSON.parse(readFileSync(path.join(agentsRoot, "package.json"), "utf-8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({
      [CLAUDE_ADAPTER_PACKAGE.npmPackage]: CLAUDE_ADAPTER_PACKAGE.pinnedVersion,
    });
    expect(existsSync(path.join(home, "package.json"))).toBe(false);
  });

  it("derives the install lock's staleness/timeout from the agent root's own (30 min) npm timeout", async () => {
    // Regression for the concurrency bug fixed alongside this test: the lock
    // guarding this root's npm install must never go stale before the 30-min
    // npm install it protects could plausibly still be running. Spy on the
    // real acquireInstallLock (delegating through to it) so this asserts the
    // actual options runtime-install.ts wires up, not just the shared
    // primitive's own derivation logic (covered separately in
    // __tests__/unit/lib/install/npm-root.test.ts).
    //
    // Runs against its OWN home: this is the only test here that reaches the
    // real `acquireInstallLock`, and a `.agent-install.lock` left in the
    // shared root by an earlier run would be held by THIS process's live pid —
    // never judged stale, so the acquire poll would run to its multi-minute
    // timeout instead of failing fast.
    setCurrentHome(mkdtempSync(path.join(tmpdir(), "libi-lockhome-")));
    const npmRoot = await import("@/lib/install/npm-root");
    const acquireInstallLockSpy = vi.fn(npmRoot.acquireInstallLock);
    vi.doMock("@/lib/install/npm-root", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/install/npm-root")>();
      return { ...actual, acquireInstallLock: acquireInstallLockSpy };
    });
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
      ) => cb(null, { stdout: "", stderr: "" }), // never lands the package — irrelevant to this test
    }));

    const { ensureClaudeAdapterInstalled, AGENT_NPM_INSTALL_TIMEOUT_MS } = await import(
      "@/lib/agents/runtime-install"
    );
    await ensureClaudeAdapterInstalled({ repoRoot });

    expect(acquireInstallLockSpy).toHaveBeenCalledTimes(1);
    const options = acquireInstallLockSpy.mock.calls[0][1] as {
      staleMs?: number;
      timeoutMs?: number;
    };
    // The invariant itself: staleness must exceed the npm timeout it guards.
    // This would fail if a future edit raised AGENT_NPM_INSTALL_TIMEOUT_MS
    // without the lock timing following (e.g. reverting to a hand-picked
    // staleMs), which is exactly the bug this wiring closes.
    expect(options.staleMs).toBeGreaterThan(AGENT_NPM_INSTALL_TIMEOUT_MS);
    expect(options.timeoutMs).toBeGreaterThanOrEqual(options.staleMs!);
    // Explicit timeout, well above vitest's 5s default. This is the ONLY test
    // in the file that reaches the REAL `acquireInstallLock`, so it does real
    // filesystem lock work rather than mocked work: measured at 1459 ms
    // uncontended, i.e. barely 3.4x under the default. In a full parallel
    // `npm test` that margin disappears and the test times out — which is
    // exactly the flake seen on 2026-07-30, and it took the `afterEach`
    // cleanup down with it (the timed-out run's in-flight work still held the
    // temp home, so `rmSync` threw ENOTEMPTY and reported a SECOND, bogus
    // failure that pointed at the cleanup rather than the cause).
    //
    // Raising the budget rather than mocking the lock is deliberate: the whole
    // point of this test is that the real primitive gets the real options.
  }, 30_000);

  it("never throws — a failed npm install resolves with installed:false and the npm error", async () => {
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null) => void,
      ) => cb(new Error("npm exploded")),
    }));

    const { ensureClaudeAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureClaudeAdapterInstalled({ repoRoot });

    expect(result.installed).toBe(false);
    expect(result.binPath).toBeNull();
    // The REAL diagnostic reaches the caller — a user behind a proxy that
    // blocks registry.npmjs.org must not get a silent `installed: false`.
    expect(result.error).toContain("npm exploded");
  });

  it("surfaces a real diagnostic when the install ran but the package never landed", async () => {
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
      ) => {
        // npm exits 0 but wrote nothing (partial/registry-cached failure).
        cb(null, { stdout: "", stderr: "" });
      },
    }));

    const { CLAUDE_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    const { ensureClaudeAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureClaudeAdapterInstalled({ repoRoot });

    expect(result.installed).toBe(false);
    expect(result.binPath).toBeNull();
    expect(result.error).toBeTruthy();
    expect(result.error).toContain(CLAUDE_ADAPTER_PACKAGE.npmPackage);
    expect(result.error).toContain(CLAUDE_ADAPTER_PACKAGE.pinnedVersion);
  });

  it("negative-caches a failure: a second call does NOT re-run the install", async () => {
    let execFileCalls = 0;
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null) => void,
      ) => {
        execFileCalls++;
        cb(new Error("npm exploded"));
      },
    }));

    const { ensureClaudeAdapterInstalled } = await import("@/lib/agents/runtime-install");

    const first = await ensureClaudeAdapterInstalled({ repoRoot });
    expect(first.installed).toBe(false);
    expect(first.error).toContain("npm exploded");
    expect(execFileCalls).toBe(1);

    // Second call, same process/module instance: must return the SAME cached
    // failure without invoking npm again — that's the observable proof of
    // the negative cache, not a spy call-count on some internal function.
    const second = await ensureClaudeAdapterInstalled({ repoRoot });
    expect(second).toEqual(first);
    expect(execFileCalls).toBe(1);

    // A third call for good measure — the cache doesn't expire after one hit.
    const third = await ensureClaudeAdapterInstalled({ repoRoot });
    expect(third).toEqual(first);
    expect(execFileCalls).toBe(1);
  });

  it("negative cache is bypassed if the adapter bin appears on disk after a failure", async () => {
    // Proves the cache never masks the adapter becoming available some other
    // way — e.g. another tool finished the install after our failed attempt.
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null) => void,
      ) => cb(new Error("npm exploded")),
    }));

    const { ensureClaudeAdapterInstalled } = await import("@/lib/agents/runtime-install");

    const first = await ensureClaudeAdapterInstalled({ repoRoot });
    expect(first.installed).toBe(false);

    // Simulate a COMPLETE, PIN-MATCHING install landing on disk out-of-band
    // (not via this module's install path) after the cached failure.
    const { CLAUDE_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    simulateSuccessfulAdapterInstall(agentsRoot, CLAUDE_ADAPTER_PACKAGE.pinnedVersion);

    const second = await ensureClaudeAdapterInstalled({ repoRoot });
    expect(second).toEqual({ installed: true, binPath: adapterBin });
  });

  it("runs independently of the bundled-MCP install and never marks it failed", async () => {
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null) => void,
      ) => cb(new Error("npm exploded")),
    }));

    const { ensureClaudeAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const { getBundledInstallSnapshot } = await import("@/lib/mcp/bundled-install");

    const before = getBundledInstallSnapshot();
    const result = await ensureClaudeAdapterInstalled({ repoRoot });

    expect(result.installed).toBe(false);
    // A Claude-only failure must not touch the bundled-MCP snapshot — that is
    // the whole reason the two live in separate npm roots.
    const after = getBundledInstallSnapshot();
    expect(after.status).toBe(before.status);
    expect(after.status).not.toBe("failed");
    expect(after.pkgs).toEqual(before.pkgs);
  });
});

/**
 * The partial-install trap: `npm install` exits 0 when an optionalDependency
 * fails, and the ~212MB Claude binary IS an optionalDependency of
 * @anthropic-ai/claude-agent-sdk. Verifying only that the ~40KB adapter landed
 * therefore proves nothing — it reported success on a tree that throws
 * "Claude native binary not found" at the first session/new, and (before this)
 * short-circuited every later boot past the repair.
 */
describe("partial install (native binary missing)", () => {
  let repoRoot: string;

  beforeEach(() => {
    vi.resetModules();
    repoRoot = makeEmptyRepoRoot();
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "");
  });

  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.doUnmock("node:child_process");
  });

  it("reports FAILURE when npm exits 0 but the platform binary never landed", async () => {
    const { CLAUDE_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
      ) => {
        // The adapter lands and matches the pin; its optional platform dep
        // silently didn't — exactly what npm reports as a success.
        simulatePartialAdapterInstall(agentsRoot, CLAUDE_ADAPTER_PACKAGE.pinnedVersion);
        cb(null, { stdout: "", stderr: "" });
      },
    }));

    const { ensureClaudeAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureClaudeAdapterInstalled({ repoRoot });

    expect(result.installed).toBe(false);
    expect(result.binPath).toBeNull();
    // Actionable: names the missing platform package, the cause, and both fixes.
    expect(result.error).toContain(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`,
    );
    expect(result.error).toContain("optional dependency");
    expect(result.error).toContain("CLAUDE_CODE_EXECUTABLE");
  });

  it("REPAIRS a half-installed tree on the next boot instead of short-circuiting past it", async () => {
    // The wedge: `.bin/claude-agent-acp` exists and the version matches, so the
    // old early-return blessed this tree forever and only `rm -rf ~/.libi/agents`
    // recovered. A fresh module registry stands in for the next process.
    const { CLAUDE_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    simulatePartialAdapterInstall(agentsRoot, CLAUDE_ADAPTER_PACKAGE.pinnedVersion);

    let npmRuns = 0;
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
      ) => {
        npmRuns++;
        seedNativeBinary(agentsRoot); // this attempt gets the whole tarball
        cb(null, { stdout: "", stderr: "" });
      },
    }));

    const { ensureClaudeAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureClaudeAdapterInstalled({ repoRoot });

    // npm actually ran — the drift check alone would have skipped it, since the
    // adapter's version already matched the pin.
    expect(npmRuns).toBe(1);
    expect(result).toEqual({ installed: true, binPath: adapterBin });
  });

  it("keeps the healthy fast path free of npm — a COMPLETE tree still short-circuits", async () => {
    const { CLAUDE_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    simulateSuccessfulAdapterInstall(agentsRoot, CLAUDE_ADAPTER_PACKAGE.pinnedVersion);

    const execFile = vi.fn();
    vi.doMock("node:child_process", () => ({ execFile }));

    const { ensureClaudeAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureClaudeAdapterInstalled({ repoRoot });

    expect(result).toEqual({ installed: true, binPath: adapterBin });
    // The verification added for the partial-install case must not have turned
    // a healthy boot into a reinstall — it is a handful of stats, no npm.
    expect(execFile).not.toHaveBeenCalled();
  });

  it("honours CLAUDE_CODE_EXECUTABLE — a user-supplied binary is a healthy install", async () => {
    // The adapter execs this before looking at any platform package, so libi
    // must not call such a setup broken (and must not reinstall over it).
    const { CLAUDE_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    simulatePartialAdapterInstall(agentsRoot, CLAUDE_ADAPTER_PACKAGE.pinnedVersion);
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "/usr/local/bin/claude");

    const execFile = vi.fn();
    vi.doMock("node:child_process", () => ({ execFile }));

    const { ensureClaudeAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureClaudeAdapterInstalled({ repoRoot });

    expect(result).toEqual({ installed: true, binPath: adapterBin });
    expect(execFile).not.toHaveBeenCalled();
  });
});

/**
 * Completeness is not currency: a user with a healthy tree at YESTERDAY'S pin
 * passed the old fast path forever, so a pin bump reached nobody who already
 * had libi — the drift check lives inside installAgentPackages, which the
 * fast-path return never reached. That is how an adapter bump meant to give
 * every user the current Claude models shipped to fresh installs only.
 */
describe("version drift on the healthy fast path", () => {
  let repoRoot: string;

  beforeEach(() => {
    vi.resetModules();
    repoRoot = makeEmptyRepoRoot();
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "");
  });

  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.doUnmock("node:child_process");
    vi.doUnmock("@/lib/logger");
  });

  it("REINSTALLS a complete tree whose adapter version drifts from the pin", async () => {
    const { CLAUDE_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    // A COMPLETE tree (bin + native binary), at yesterday's version.
    simulateSuccessfulAdapterInstall(agentsRoot, "0.0.1-previous");
    const logs = captureLogs();

    let npmRuns = 0;
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
      ) => {
        npmRuns++;
        simulateSuccessfulAdapterInstall(agentsRoot, CLAUDE_ADAPTER_PACKAGE.pinnedVersion);
        cb(null, { stdout: "", stderr: "" });
      },
    }));

    const { ensureClaudeAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureClaudeAdapterInstalled({ repoRoot });

    // npm actually ran — the old completeness-only fast path would have
    // returned {installed:true} without it.
    expect(npmRuns).toBe(1);
    expect(result).toEqual({ installed: true, binPath: adapterBin });

    // …and the reinstall is greppable, saying WHICH condition failed. Without
    // `reason` the log cannot tell a drift repair from a partial-install
    // repair, which is the whole diagnostic value of the line.
    const repair = logs.find((r) => r.op === "claude_adapter_repair");
    expect(repair).toBeDefined();
    expect(String(repair?.reason)).toContain("version drift");
    expect(String(repair?.reason)).toContain("0.0.1-previous");
  });

  it("claudeAdapterVersionCurrent answers from the on-disk manifest", async () => {
    const { CLAUDE_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    const { claudeAdapterVersionCurrent } = await import("@/lib/agents/runtime-install");

    expect(claudeAdapterVersionCurrent(agentsRoot)).toBe(false); // nothing installed
    simulateSuccessfulAdapterInstall(agentsRoot, "0.0.1-previous");
    expect(claudeAdapterVersionCurrent(agentsRoot)).toBe(false); // drifted
    rmSync(agentsRoot, { recursive: true, force: true });
    simulateSuccessfulAdapterInstall(agentsRoot, CLAUDE_ADAPTER_PACKAGE.pinnedVersion);
    expect(claudeAdapterVersionCurrent(agentsRoot)).toBe(true); // current
  });

  it("a complete tree with NO adapter manifest is not vouched for — it reinstalls", async () => {
    // `readInstalledVersion` returns null for a missing/unreadable manifest.
    // Reading that as "current" would restore the very bug this closes, so
    // unknown counts as drifted: the cost of being wrong is one reinstall.
    const { CLAUDE_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    seedExecutable(adapterBin);
    seedNativeBinary(agentsRoot);

    let npmRuns = 0;
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
      ) => {
        npmRuns++;
        simulateSuccessfulAdapterInstall(agentsRoot, CLAUDE_ADAPTER_PACKAGE.pinnedVersion);
        cb(null, { stdout: "", stderr: "" });
      },
    }));

    const { ensureClaudeAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureClaudeAdapterInstalled({ repoRoot });

    expect(npmRuns).toBe(1);
    expect(result).toEqual({ installed: true, binPath: adapterBin });
  });

  it("KEEPS a working-but-stale tree when the upgrade cannot be downloaded", async () => {
    // The upgrade must never leave a user worse off than the outdated install
    // they already had: offline, the reinstall fails and Claude Code has to
    // stay available on the version already on disk. Reporting installed:false
    // here would take a working agent away over a failed download.
    simulateSuccessfulAdapterInstall(agentsRoot, "0.0.1-previous");
    const logs = captureLogs();

    let npmRuns = 0;
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null) => void,
      ) => {
        npmRuns++;
        cb(new Error("npm ERR! code ENOTFOUND registry.npmjs.org"));
      },
    }));

    const { ensureClaudeAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const first = await ensureClaudeAdapterInstalled({ repoRoot });

    // Usable — but NOT reported as a plain success. `upgradeError` is the only
    // thing separating this from a real install; without it Category A logs
    // "ready" and the agent_install job emits `agent_install_completed` for a
    // rollout that reached nobody.
    expect(first.installed).toBe(true);
    expect(first.binPath).toBe(adapterBin);
    expect(first.staleVersion).toBe("0.0.1-previous");
    expect(first.upgradeError).toContain("ENOTFOUND");
    expect(npmRuns).toBe(1);

    // The failure is greppable in ~/.libi/logs/libi.log: it is the ONLY
    // record that this boot failed to upgrade, since the return value says
    // installed:true.
    const kept = logs.find((r) => r.op === "claude_adapter_upgrade_failed_stale_kept");
    expect(kept).toBeDefined();
    expect(kept?.installed).toBe("0.0.1-previous");
    expect(String(kept?.error)).toContain("ENOTFOUND");

    // …and the doomed upgrade is not re-attempted for the rest of the process:
    // every later caller would otherwise pay the npm timeout again for an
    // install this process has already proven it cannot complete.
    const second = await ensureClaudeAdapterInstalled({ repoRoot });
    expect(npmRuns).toBe(1);
    // The SECOND caller must hear the same verdict. A bare "we gave up" flag
    // would re-open the fast path and hand it a clean success for exactly the
    // tree the first caller just reported as a failed upgrade.
    expect(second).toEqual(first);
  });

  it("reports a stale tree as usable-but-not-upgraded when npm exits 0 without landing the pin", async () => {
    // A yanked version, or a registry serving a stale manifest: npm reports
    // success and the pin still isn't on disk. Post-install verification is
    // the only thing that notices, and its verdict has to reach the caller —
    // an exit code of 0 must not become an unqualified success.
    simulateSuccessfulAdapterInstall(agentsRoot, "0.0.1-previous");

    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
      ) => cb(null, { stdout: "", stderr: "" }),
    }));

    const { ensureClaudeAdapterInstalled, installFailureReason } = await import(
      "@/lib/agents/runtime-install"
    );
    const result = await ensureClaudeAdapterInstalled({ repoRoot });

    expect(result.installed).toBe(true);
    expect(result.staleVersion).toBe("0.0.1-previous");
    // Bounded when it reaches analytics — the synthetic message deliberately
    // uses describeDrift's wording so it maps, rather than landing in
    // "unknown" and being indistinguishable from every other failure.
    expect(installFailureReason(result.upgradeError!)).toBe("version_drift");
  });
});

describe("Windows bin resolution", () => {
  afterEach(() => rmSync(agentsRoot, { recursive: true, force: true }));

  it("prefers .cmd on win32 and the bare name everywhere else", async () => {
    const { adapterBinFileNames } = await import("@/lib/agents/runtime-install");
    // npm's cmd-shim writes three files for one bin; only the .cmd can be
    // handed to spawn() without a shell.
    expect(adapterBinFileNames("claude-agent-acp", "win32")).toEqual([
      "claude-agent-acp.cmd",
      "claude-agent-acp.exe",
    ]);
    expect(adapterBinFileNames("claude-agent-acp", "darwin")).toEqual(["claude-agent-acp"]);
    expect(adapterBinFileNames("claude-agent-acp", "linux")).toEqual(["claude-agent-acp"]);
  });

  it("resolves the .cmd shim, not the extensionless bash script, on win32", async () => {
    // Both exist side by side after a real npm install on Windows. accessSync
    // can't tell them apart there (X_OK is F_OK on Windows), so returning the
    // first hit would hand spawn() a bash script → ENOEXEC.
    seedExecutable(adapterBin);
    seedExecutable(`${adapterBin}.cmd`);

    const { resolveInstalledAdapterBin, resolveRepoLocalAdapterBin } = await import(
      "@/lib/agents/runtime-install"
    );
    withPlatform("win32", () => {
      expect(resolveInstalledAdapterBin()).toBe(`${adapterBin}.cmd`);
      expect(resolveRepoLocalAdapterBin(agentsRoot)).toBe(`${adapterBin}.cmd`);
    });
  });

  it("returns null on win32 when only the bash shim exists — never a bin that can't spawn", async () => {
    seedExecutable(adapterBin);

    const { resolveInstalledAdapterBin } = await import("@/lib/agents/runtime-install");
    withPlatform("win32", () => {
      expect(resolveInstalledAdapterBin()).toBeNull();
    });
    // …while the same tree resolves fine on a POSIX platform.
    expect(resolveInstalledAdapterBin()).toBe(adapterBin);
  });
});

describe("adapter resolution order", () => {
  it("prefers the repo-local bin so dev is unaffected", async () => {
    const { resolveClaudeAdapterBin } = await import("@/lib/agents/runtime-install");
    const repoLocal = "/repo/node_modules/.bin/claude-agent-acp";
    expect(resolveClaudeAdapterBin({ repoLocal, installed: "/home/.libi/node_modules/.bin/claude-agent-acp" }))
      .toBe(repoLocal);
  });

  it("falls back to the runtime-installed bin", async () => {
    const { resolveClaudeAdapterBin } = await import("@/lib/agents/runtime-install");
    const installed = "/home/.libi/node_modules/.bin/claude-agent-acp";
    expect(resolveClaudeAdapterBin({ repoLocal: null, installed })).toBe(installed);
  });

  it("returns null rather than falling back to npx", async () => {
    const { resolveClaudeAdapterBin } = await import("@/lib/agents/runtime-install");
    expect(resolveClaudeAdapterBin({ repoLocal: null, installed: null })).toBeNull();
  });
});

/**
 * The reason an unavailable Claude Code shows in the agent selector. Before
 * this, the entry simply VANISHED and the "still installing" line reached only
 * ~/.libi/logs/libi.log — so a first-boot user waiting on a ~212MB download
 * saw an empty list with no explanation.
 */
describe("claudeAdapterUnavailableReason", () => {
  const lockPath = path.join(agentsRoot, ".agent-install.lock");

  beforeEach(() => {
    vi.resetModules();
    mkdirSync(agentsRoot, { recursive: true });
  });

  afterEach(() => rmSync(agentsRoot, { recursive: true, force: true }));

  it("reports 'installing' while ANOTHER process holds the install lock", async () => {
    // Category A runs the install in the CLI process (bin/libi.js) before
    // Next.js exists, so the in-memory inflight promise can never answer this
    // for the server that renders the selector — the cross-process lock can.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

    const { claudeAdapterUnavailableReason } = await import("@/lib/agents/runtime-install");
    const reason = claudeAdapterUnavailableReason(null);
    expect(reason.code).toBe("installing");
    // The figure, not just the code. This lock is held by the npm install of
    // the WHOLE `~/.libi/agents` tree, so the number here must be the
    // whole-install one (~345 MB) and not the platform binary's ~306 MB — the
    // two were out of sync until 2026-08-26. Nothing else asserts this string
    // against production: the agent-selector and install-progress fixtures feed
    // their copy in as input props, so it could have drifted with a green suite.
    expect(reason.message).toContain("345 MB");
  });

  it("ignores a STALE lock — an abandoned install must not read as 'installing' forever", async () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() - 60 * 60 * 1000 }),
    );

    const { claudeAdapterUnavailableReason } = await import("@/lib/agents/runtime-install");
    expect(claudeAdapterUnavailableReason(null).code).not.toBe("installing");
  });

  it("reports 'not_installed' when no install has ever been attempted in this root", async () => {
    const { claudeAdapterUnavailableReason } = await import("@/lib/agents/runtime-install");
    const reason = claudeAdapterUnavailableReason(null);
    expect(reason.code).toBe("not_installed");
    expect(reason.message).toMatch(/isn't installed/i);
  });

  it("reports 'install_failed' once a manifest proves an install ran here", async () => {
    // writePackageJson runs immediately before npm, so its output is the
    // on-disk fact that separates "it failed" from "it never ran".
    writeFileSync(path.join(agentsRoot, "package.json"), JSON.stringify({ name: "libi-runtime-agents" }));

    const { claudeAdapterUnavailableReason } = await import("@/lib/agents/runtime-install");
    expect(claudeAdapterUnavailableReason(null).code).toBe("install_failed");
  });

  it("reuses pendingInstallReason's vocabulary for the half-installed tree", async () => {
    const { claudeAdapterUnavailableReason } = await import("@/lib/agents/runtime-install");
    // binRoot non-null = the adapter resolved, so the ONLY way we're here is
    // the optional-dependency trap: adapter present, native binary absent.
    const reason = claudeAdapterUnavailableReason(agentsRoot);
    expect(reason.code).toBe("install_failed");
    expect(reason.detail).toBe("native binary missing");
  });
});
