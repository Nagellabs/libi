import { describe, expect, it, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(tmpdir(), "libi-home-"));
const agentsRoot = path.join(home, "agents");
const adapterBin = path.join(agentsRoot, "node_modules", ".bin", "claude-agent-acp");
const codexAdapterBin = path.join(agentsRoot, "node_modules", ".bin", "codex-acp");

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
 * What a real `npm install --omit=optional` of the adapter leaves on disk: the
 * adapter's manifest at `version` and its `.bin` shim. There is no engine —
 * the chat runs the user's own CLI — so this IS a complete install.
 */
function simulateSuccessfulAdapterInstall(root: string, version: string): void {
  const pkgDir = path.join(root, "node_modules", "@agentclientprotocol", "claude-agent-acp");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ version }));
  seedExecutable(path.join(root, "node_modules", ".bin", "claude-agent-acp"));
}

/** The Codex twin of `simulateSuccessfulAdapterInstall`. */
function simulateSuccessfulCodexInstall(root: string, version: string): void {
  const pkgDir = path.join(root, "node_modules", "@agentclientprotocol", "codex-acp");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ version }));
  seedExecutable(path.join(root, "node_modules", ".bin", "codex-acp"));
}

/** `dependencies` of the manifest `writePackageJson` left in the agent root. */
function readAgentManifest(): Record<string, string> {
  return (
    JSON.parse(readFileSync(path.join(agentsRoot, "package.json"), "utf-8")) as {
      dependencies: Record<string, string>;
    }
  ).dependencies;
}

type ExecFileCb = (err: Error | null, res: { stdout: string; stderr: string }) => void;

/**
 * A fake `npm install` that records the manifest it was handed and then lays
 * down whatever `land` says. Reading the manifest INSIDE the call is the
 * point: it is the exact document npm would reify `node_modules` to, so its
 * contents are what decides whether the other adapter survives the install.
 */
function mockNpmInstall(land: () => void): { manifests: Record<string, string>[]; runs: () => number } {
  const manifests: Record<string, string>[] = [];
  vi.doMock("node:child_process", () => ({
    execFile: (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
      manifests.push(readAgentManifest());
      land();
      cb(null, { stdout: "", stderr: "" });
    },
  }));
  return { manifests, runs: () => manifests.length };
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

  it("short-circuits without installing when the adapter is present AND matches the pin", async () => {
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
    // The adapters' engines are optionalDependencies and are never installed.
    expect(capturedArgs!).toContain("--omit=optional");
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

    // Simulate a PIN-MATCHING install landing on disk out-of-band
    // (not via this module's install path) after the cached failure.
    const { CLAUDE_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    simulateSuccessfulAdapterInstall(agentsRoot, CLAUDE_ADAPTER_PACKAGE.pinnedVersion);

    const second = await ensureClaudeAdapterInstalled({ repoRoot });
    expect(second).toEqual({ installed: true, binPath: adapterBin });
  });
});

/**
 * A present adapter is not a current one: a user with a healthy tree at YESTERDAY'S pin
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
  });

  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.doUnmock("node:child_process");
    vi.doUnmock("@/lib/logger");
  });

  it("REINSTALLS a tree whose adapter version drifts from the pin", async () => {
    const { CLAUDE_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    // An installed tree (manifest + bin), at yesterday's version.
    simulateSuccessfulAdapterInstall(agentsRoot, "0.0.1-previous");
    const logs = captureLogs();

    const npm = mockNpmInstall(() =>
      simulateSuccessfulAdapterInstall(agentsRoot, CLAUDE_ADAPTER_PACKAGE.pinnedVersion),
    );

    const { ensureClaudeAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureClaudeAdapterInstalled({ repoRoot });

    // npm actually ran — a bin-only fast path would have returned
    // {installed:true} without it.
    expect(npm.runs()).toBe(1);
    expect(result).toEqual({ installed: true, binPath: adapterBin });

    // …and the manifest npm was handed carries the PIN for the requested
    // package, not the installed 0.0.1-previous. The manifest is built from
    // what is on disk (so the other adapter survives), and the whole point of
    // a drift repair is that the requested entry is overwritten by the pin.
    expect(npm.manifests[0][CLAUDE_ADAPTER_PACKAGE.npmPackage]).toBe(
      CLAUDE_ADAPTER_PACKAGE.pinnedVersion,
    );

    // …and the reinstall is greppable, saying WHICH condition failed. Without
    // `reason` the log cannot say what was stale, which is the whole
    // diagnostic value of the line.
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

  it("a bin with NO adapter manifest is not vouched for — it reinstalls", async () => {
    // `readInstalledVersion` returns null for a missing/unreadable manifest.
    // Reading that as "current" would restore the very bug this closes, so
    // unknown counts as drifted: the cost of being wrong is one reinstall.
    const { CLAUDE_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    seedExecutable(adapterBin);

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
 * ~/.libi/logs/libi.log — so a first-boot user waiting on the download saw an
 * empty list with no explanation.
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
    // The figure, not just the code: the adapter's JS-only install size (the
    // engines are never installed), the same number the setup card quotes.
    // Nothing else asserts this string against production: the agent-selector
    // and install-progress fixtures feed their copy in as input props, so it
    // could have drifted with a green suite.
    expect(reason.message).toContain("56 MB");
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
    expect(reason.message).toMatch(/isn't downloaded/i);
    // Set up from the Agents page — restarting libi installs nothing.
    expect(reason.message).toContain("set it up in Agents");
  });

  it("reports 'install_failed' once a manifest proves an install ran here", async () => {
    // writePackageJson runs immediately before npm, so its output is the
    // on-disk fact that separates "it failed" from "it never ran".
    const { CLAUDE_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    writeFileSync(
      path.join(agentsRoot, "package.json"),
      JSON.stringify({
        name: "libi-runtime-agents",
        dependencies: { [CLAUDE_ADAPTER_PACKAGE.npmPackage]: CLAUDE_ADAPTER_PACKAGE.pinnedVersion },
      }),
    );

    const { claudeAdapterUnavailableReason } = await import("@/lib/agents/runtime-install");
    expect(claudeAdapterUnavailableReason(null).code).toBe("install_failed");
    expect(claudeAdapterUnavailableReason(null).message).toContain("retry from Agents");
  });

  // The user's CLI may already be installed, and the wizard says so; what libi
  // fetches here is its own support for running it. The selector's reason uses
  // the wizard's words for it (adapter-copy.ts), so it never reads "install".
  it("words all three reasons as the download they are, in the wizard's words", async () => {
    const { claudeAdapterUnavailableReason } = await import("@/lib/agents/runtime-install");
    const messages: string[] = [];
    const notInstalled = claudeAdapterUnavailableReason(null).message;
    messages.push(notInstalled);
    expect(notInstalled).toBe("Claude Code support isn't downloaded yet — set it up in Agents.");

    const { CLAUDE_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    writeFileSync(
      path.join(agentsRoot, "package.json"),
      JSON.stringify({
        name: "libi-runtime-agents",
        dependencies: { [CLAUDE_ADAPTER_PACKAGE.npmPackage]: CLAUDE_ADAPTER_PACKAGE.pinnedVersion },
      }),
    );
    const failed = claudeAdapterUnavailableReason(null).message;
    messages.push(failed);
    expect(failed).toBe("Couldn't download Claude Code support — retry from Agents.");

    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    const downloading = claudeAdapterUnavailableReason(null).message;
    messages.push(downloading);
    expect(downloading).toBe("Downloading Claude Code support (56 MB) — this can take a few minutes.");

    for (const message of messages) expect(message).not.toMatch(/install/i);
  });

  it("a manifest written by the OTHER adapter's install is not evidence this one was attempted", async () => {
    // The manifest is shared between the two adapters. A Codex install that
    // ran while Claude was not on disk writes a manifest listing only Codex —
    // reading that as "Claude's install failed" would tell a user to retry an
    // install that never happened.
    const { CODEX_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    writeFileSync(
      path.join(agentsRoot, "package.json"),
      JSON.stringify({
        name: "libi-runtime-agents",
        dependencies: { [CODEX_ADAPTER_PACKAGE.npmPackage]: CODEX_ADAPTER_PACKAGE.pinnedVersion },
      }),
    );

    const { claudeAdapterUnavailableReason, adapterUnavailableReason } = await import(
      "@/lib/agents/runtime-install"
    );
    expect(claudeAdapterUnavailableReason(null).code).toBe("not_installed");
    expect(adapterUnavailableReason(null, CODEX_ADAPTER_PACKAGE).code).toBe("install_failed");
  });

});

/**
 * Both adapters now install at runtime into ONE npm root (`~/.libi/agents`),
 * and a bare `npm install --no-save` reifies `node_modules` to the manifest it
 * is given — verified against the vendored npm: a package absent from the
 * manifest is PRUNED. So each install is scoped to the agent that was asked
 * for (drift, verification, the negative cache), while the manifest it writes
 * is the union of that package at its pin plus every other adapter already on
 * disk at its CURRENTLY INSTALLED version — satisfied as far as npm is
 * concerned, so neither downloaded again nor deleted.
 */
describe("ensureAgentAdapterInstalled — scoped to one agent, manifest keeps the other", () => {
  let repoRoot: string;

  beforeEach(() => {
    vi.resetModules();
    repoRoot = makeEmptyRepoRoot();
  });

  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.doUnmock("node:child_process");
    vi.doUnmock("@/lib/install/npm-root");
  });

  it("passes --omit=optional to npm", async () => {
    // The adapters list their engines as optionalDependencies; the chat runs
    // the user's own CLI, so npm is told to leave them out.
    const { CODEX_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    const runNpmInstall = vi.fn(async () => {
      simulateSuccessfulCodexInstall(agentsRoot, CODEX_ADAPTER_PACKAGE.pinnedVersion);
    });
    vi.doMock("@/lib/install/npm-root", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/install/npm-root")>();
      return { ...actual, runNpmInstall };
    });

    const { ensureAgentAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureAgentAdapterInstalled("codex", { repoRoot });

    expect(result).toEqual({ installed: true, binPath: codexAdapterBin });
    expect(runNpmInstall).toHaveBeenCalledTimes(1);
    expect(runNpmInstall).toHaveBeenCalledWith(agentsRoot, expect.objectContaining({ omitOptional: true }));
  });

  it("asking for Codex does not download Claude — an adapter NOT on disk is not added to the manifest", async () => {
    const { CLAUDE_ADAPTER_PACKAGE, CODEX_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    const npm = mockNpmInstall(() =>
      simulateSuccessfulCodexInstall(agentsRoot, CODEX_ADAPTER_PACKAGE.pinnedVersion),
    );

    const { ensureAgentAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureAgentAdapterInstalled("codex", { repoRoot });

    expect(result).toEqual({ installed: true, binPath: codexAdapterBin });
    expect(npm.runs()).toBe(1);
    expect(npm.manifests[0]).toEqual({
      [CODEX_ADAPTER_PACKAGE.npmPackage]: CODEX_ADAPTER_PACKAGE.pinnedVersion,
    });
    expect(npm.manifests[0]).not.toHaveProperty(CLAUDE_ADAPTER_PACKAGE.npmPackage);
    // …and nothing of Claude's appeared in the tree as a side effect.
    expect(existsSync(adapterBin)).toBe(false);
  });

  it("asking for Codex does not delete an installed Claude — it is kept in the manifest at its INSTALLED version, not the pin", async () => {
    const { CLAUDE_ADAPTER_PACKAGE, CODEX_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    // An installed Claude tree at YESTERDAY'S version. If the manifest said
    // the current pin, npm would try to upgrade it — a Codex install must not
    // spend a download on an agent nobody asked about.
    simulateSuccessfulAdapterInstall(agentsRoot, "0.0.1-previous");
    const npm = mockNpmInstall(() =>
      simulateSuccessfulCodexInstall(agentsRoot, CODEX_ADAPTER_PACKAGE.pinnedVersion),
    );

    const { ensureAgentAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureAgentAdapterInstalled("codex", { repoRoot });

    expect(result).toEqual({ installed: true, binPath: codexAdapterBin });
    expect(npm.manifests[0]).toEqual({
      [CLAUDE_ADAPTER_PACKAGE.npmPackage]: "0.0.1-previous",
      [CODEX_ADAPTER_PACKAGE.npmPackage]: CODEX_ADAPTER_PACKAGE.pinnedVersion,
    });
    expect(existsSync(adapterBin)).toBe(true);
  });

  it("mirror: asking for Claude keeps an installed Codex in the manifest at its installed version", async () => {
    const { CLAUDE_ADAPTER_PACKAGE, CODEX_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    simulateSuccessfulCodexInstall(agentsRoot, "0.0.1-previous");
    const npm = mockNpmInstall(() =>
      simulateSuccessfulAdapterInstall(agentsRoot, CLAUDE_ADAPTER_PACKAGE.pinnedVersion),
    );

    const { ensureAgentAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureAgentAdapterInstalled("claude-code", { repoRoot });

    expect(result).toEqual({ installed: true, binPath: adapterBin });
    expect(npm.manifests[0]).toEqual({
      [CLAUDE_ADAPTER_PACKAGE.npmPackage]: CLAUDE_ADAPTER_PACKAGE.pinnedVersion,
      [CODEX_ADAPTER_PACKAGE.npmPackage]: "0.0.1-previous",
    });
    expect(existsSync(codexAdapterBin)).toBe(true);
  });

  it("drift and verification stay scoped to the requested package — a stale Claude does not fail or taint a Codex install", async () => {
    const { CODEX_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    simulateSuccessfulAdapterInstall(agentsRoot, "0.0.1-previous");
    mockNpmInstall(() =>
      simulateSuccessfulCodexInstall(agentsRoot, CODEX_ADAPTER_PACKAGE.pinnedVersion),
    );

    const { ensureAgentAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureAgentAdapterInstalled("codex", { repoRoot });

    // A clean success: no `upgradeError`/`staleVersion` borrowed from the
    // other adapter's drift.
    expect(result).toEqual({ installed: true, binPath: codexAdapterBin });
  });

  it("an installed, current Codex tree short-circuits without npm, whatever state Claude is in", async () => {
    const { CODEX_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    simulateSuccessfulCodexInstall(agentsRoot, CODEX_ADAPTER_PACKAGE.pinnedVersion);
    const execFile = vi.fn();
    vi.doMock("node:child_process", () => ({ execFile }));

    const { ensureAgentAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureAgentAdapterInstalled("codex", { repoRoot });

    expect(result).toEqual({ installed: true, binPath: codexAdapterBin });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("negative cache is per agent — a failed Claude install does not short-circuit a Codex install", async () => {
    const { CODEX_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    let calls = 0;
    vi.doMock("node:child_process", () => ({
      execFile: (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
        calls++;
        if (calls === 1) {
          cb(new Error("npm exploded"), { stdout: "", stderr: "" });
          return;
        }
        simulateSuccessfulCodexInstall(agentsRoot, CODEX_ADAPTER_PACKAGE.pinnedVersion);
        cb(null, { stdout: "", stderr: "" });
      },
    }));

    const { ensureAgentAdapterInstalled } = await import("@/lib/agents/runtime-install");

    const claude = await ensureAgentAdapterInstalled("claude-code", { repoRoot });
    expect(claude.installed).toBe(false);
    expect(claude.error).toContain("npm exploded");
    expect(calls).toBe(1);

    // Codex must get its own attempt, not Claude's cached failure.
    const codex = await ensureAgentAdapterInstalled("codex", { repoRoot });
    expect(codex).toEqual({ installed: true, binPath: codexAdapterBin });
    expect(calls).toBe(2);

    // …while Claude's failure is still cached for Claude.
    const claudeAgain = await ensureAgentAdapterInstalled("claude-code", { repoRoot });
    expect(claudeAgain).toEqual(claude);
    expect(calls).toBe(2);
  });

  it("dev skip fires per adapter: a repo-local codex-acp short-circuits the Codex install", async () => {
    const repoBin = path.join(repoRoot, "node_modules", ".bin", "codex-acp");
    seedExecutable(repoBin);
    const execFile = vi.fn();
    vi.doMock("node:child_process", () => ({ execFile }));

    const { ensureAgentAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureAgentAdapterInstalled("codex", { repoRoot });

    expect(result).toEqual({ installed: true, binPath: repoBin });
    expect(execFile).not.toHaveBeenCalled();
    expect(existsSync(agentsRoot)).toBe(false);
  });

  it("an agent with no runtime adapter resolves installed:false with a reason — never throws, never runs npm", async () => {
    const execFile = vi.fn();
    vi.doMock("node:child_process", () => ({ execFile }));

    const { ensureAgentAdapterInstalled } = await import("@/lib/agents/runtime-install");
    const result = await ensureAgentAdapterInstalled("terminal", { repoRoot });

    expect(result.installed).toBe(false);
    expect(result.binPath).toBeNull();
    expect(result.error).toContain("terminal");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("ensureClaudeAdapterInstalled is the Claude-only alias of ensureAgentAdapterInstalled", async () => {
    const { CLAUDE_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-packages");
    simulateSuccessfulAdapterInstall(agentsRoot, CLAUDE_ADAPTER_PACKAGE.pinnedVersion);
    const execFile = vi.fn();
    vi.doMock("node:child_process", () => ({ execFile }));

    const { ensureClaudeAdapterInstalled, ensureAgentAdapterInstalled } = await import(
      "@/lib/agents/runtime-install"
    );
    expect(await ensureClaudeAdapterInstalled({ repoRoot })).toEqual(
      await ensureAgentAdapterInstalled("claude-code", { repoRoot }),
    );
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("per-package resolution and unavailability reasons", () => {
  beforeEach(() => {
    vi.resetModules();
    mkdirSync(agentsRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("resolveInstalledAdapterBin / resolveRepoLocalAdapterBin resolve the package they are given, and default to Claude", async () => {
    seedExecutable(adapterBin);
    seedExecutable(codexAdapterBin);

    const { resolveInstalledAdapterBin, resolveRepoLocalAdapterBin, CODEX_ADAPTER_PACKAGE, CLAUDE_ADAPTER_PACKAGE } =
      await import("@/lib/agents/runtime-install");

    expect(resolveInstalledAdapterBin()).toBe(adapterBin);
    expect(resolveInstalledAdapterBin(CLAUDE_ADAPTER_PACKAGE)).toBe(adapterBin);
    expect(resolveInstalledAdapterBin(CODEX_ADAPTER_PACKAGE)).toBe(codexAdapterBin);
    expect(resolveRepoLocalAdapterBin(agentsRoot)).toBe(adapterBin);
    expect(resolveRepoLocalAdapterBin(agentsRoot, CODEX_ADAPTER_PACKAGE)).toBe(codexAdapterBin);
  });

  it("adapterVersionCurrent answers per package from the on-disk manifest", async () => {
    const { adapterVersionCurrent, CODEX_ADAPTER_PACKAGE, CLAUDE_ADAPTER_PACKAGE } = await import(
      "@/lib/agents/runtime-install"
    );
    expect(adapterVersionCurrent(agentsRoot, CODEX_ADAPTER_PACKAGE)).toBe(false);
    simulateSuccessfulCodexInstall(agentsRoot, CODEX_ADAPTER_PACKAGE.pinnedVersion);
    expect(adapterVersionCurrent(agentsRoot, CODEX_ADAPTER_PACKAGE)).toBe(true);
    // Codex being current says nothing about Claude.
    expect(adapterVersionCurrent(agentsRoot, CLAUDE_ADAPTER_PACKAGE)).toBe(false);
  });

  it("adapterUnavailableReason names the agent it was asked about", async () => {
    const { adapterUnavailableReason, claudeAdapterUnavailableReason, CODEX_ADAPTER_PACKAGE, CLAUDE_ADAPTER_PACKAGE } =
      await import("@/lib/agents/runtime-install");

    const codex = adapterUnavailableReason(null, CODEX_ADAPTER_PACKAGE);
    expect(codex.code).toBe("not_installed");
    expect(codex.message).toContain("Codex");
    expect(codex.message).not.toContain("Claude");
    // "Reinstall libi" was the old advice for a missing bundled adapter; now
    // that the adapter is downloaded on selection it is simply not installed yet.
    expect(codex.message).not.toMatch(/reinstall/i);

    expect(claudeAdapterUnavailableReason(null)).toEqual(
      adapterUnavailableReason(null, CLAUDE_ADAPTER_PACKAGE),
    );
  });

  it("adapterUnavailableReason quotes the Codex download size while the lock is held", async () => {
    writeFileSync(
      path.join(agentsRoot, ".agent-install.lock"),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
    );
    const { adapterUnavailableReason, CODEX_ADAPTER_PACKAGE } = await import("@/lib/agents/runtime-install");
    const reason = adapterUnavailableReason(null, CODEX_ADAPTER_PACKAGE);
    expect(reason.code).toBe("installing");
    expect(reason.message).toContain("Codex");
    expect(reason.message).toContain("17 MB");
  });
});
