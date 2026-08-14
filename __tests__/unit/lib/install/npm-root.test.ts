import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import {
  acquireInstallLock,
  lockTimingForNpmTimeout,
  npmInstallArgs,
  npmResolveAnchors,
  runNpmInstall,
  runNpmViaUtilityProcess,
  selectNpmRunner,
  type UtilityProcessForkFn,
  type UtilityProcessLike,
} from "@/lib/install/npm-root";

/**
 * `lockTimingForNpmTimeout` is the fix for a real concurrency bug: before it
 * existed, the bundled-MCP root's npm timeout (5 min) and the install lock's
 * staleness (hardcoded 10 min) happened to satisfy `npmTimeout < lockStale`
 * because there was only one npm timeout in the codebase. Giving the agent
 * root its own 30-min npm timeout broke that invariant silently — a
 * still-running 14-minute install could have its lock judged "stale" and
 * stolen by a second process, which then started a COLLIDING second
 * `npm install` into the same `node_modules`.
 *
 * These tests assert the *relationship* the function must uphold for ANY
 * npm timeout, not a hardcoded pair of numbers — so they keep failing (would
 * fail) for any future root whose lock timing is computed any other way.
 */
describe("lockTimingForNpmTimeout", () => {
  it.each([
    1,
    1_000,
    60_000,
    5 * 60_000, // bundled-MCP root's npm timeout
    30 * 60_000, // agent root's npm timeout
    2 * 60 * 60_000, // a hypothetical future, much larger root timeout
  ])("keeps lock staleness strictly greater than the npm timeout it guards (npmTimeoutMs=%d)", (npmTimeoutMs) => {
    const { staleMs, timeoutMs } = lockTimingForNpmTimeout(npmTimeoutMs);

    // The core invariant: a lock can never be judged stale before the npm
    // install it protects would have timed out on its own.
    expect(staleMs).toBeGreaterThan(npmTimeoutMs);
    // The overall lock-acquisition timeout must never be tighter than
    // staleness — otherwise callers give up before ever getting a chance to
    // steal a genuinely stale lock.
    expect(timeoutMs).toBeGreaterThanOrEqual(staleMs);
  });

  it("scales staleMs up when the npm timeout grows, instead of staying fixed", () => {
    const small = lockTimingForNpmTimeout(5 * 60_000);
    const large = lockTimingForNpmTimeout(30 * 60_000);

    // If a future change raises a root's npm timeout, its derived lock
    // timing must rise with it — this is what "holds by construction" means
    // in practice, and is exactly what a hand-maintained pair of constants
    // failed to do.
    expect(large.staleMs).toBeGreaterThan(small.staleMs);
    expect(large.timeoutMs).toBeGreaterThan(small.timeoutMs);
  });
});

describe("acquireInstallLock diagnostics", () => {
  it("threads the caller's logTag into the timeout error, not a hardcoded 'bundled-install'", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "npm-root-lock-"));
    const lockFile = ".test-install.lock";
    // A lock held by OUR OWN pid (so process.kill(pid, 0) reports it alive)
    // with a startedAt inside the (generous) staleMs window below — never
    // judged stale, so acquireInstallLock can only give up via its
    // acquisition timeout, exercising the exact error string that reaches
    // EnsureAdapterResult.error for a real agent-root lock timeout.
    writeFileSync(
      path.join(dir, lockFile),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
    );

    await expect(
      acquireInstallLock(dir, {
        lockFile,
        logTag: "agent-install",
        staleMs: 60_000,
        timeoutMs: 10,
      }),
    ).rejects.toThrow(/^agent-install lock not released within 10ms$/);

    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * `selectNpmRunner` is the fix for a shipping blocker: the packaged Electron
 * app ran npm by spawning `process.execPath` with `ELECTRON_RUN_AS_NODE=1`.
 * `electron-builder.yml` sets the `runAsNode: false` security fuse, so Electron
 * IGNORES that variable — the spawn launched a second Libi GUI instead of npm
 * and the adapter install hung until its 30-minute timeout.
 *
 * These assert the branch is made on the RUNTIME (`process.versions.electron`),
 * not on how libi was packaged, and that the plain-Node path is untouched.
 */
describe("selectNpmRunner", () => {
  it("uses Electron's utilityProcess when running inside Electron", () => {
    // `process.execPath` is the Libi binary here and the runAsNode fuse is off,
    // so execFile-ing it can never run npm — utilityProcess.fork is the only
    // way to get a genuine Node child.
    expect(selectNpmRunner({ electron: "38.2.1" })).toBe("electron-utility-process");
  });

  it("keeps the plain-Node execFile path when there is no Electron runtime", () => {
    // `npx libi` / the CLI: `process.execPath` IS a real node, so the original
    // behaviour must survive untouched.
    expect(selectNpmRunner({})).toBe("execfile-node");
    expect(selectNpmRunner({ electron: undefined })).toBe("execfile-node");
  });

  it("defaults to this process's real runtime, so tests exercise the CLI path", () => {
    // Vitest runs under plain Node — a regression that made the selector
    // Electron-only (or always-Electron) would surface right here.
    expect(selectNpmRunner()).toBe("execfile-node");
    expect(selectNpmRunner()).toBe(
      process.versions.electron ? "electron-utility-process" : "execfile-node",
    );
  });
});

/**
 * The vendored npm CLI used to be located with a bundler-VISIBLE
 * `require.resolve("npm/package.json")`. Turbopack bundles that target and
 * rewrites the call to the module's numeric id, so the production build
 * emitted `path.join(path.dirname(467884), "bin", "npm-cli.js")` and the
 * function threw `TypeError: The "path" argument must be of type string`
 * in every bundled build. Resolution now goes through a runtime
 * `createRequire` anchored on these directories.
 */
describe("npmResolveAnchors", () => {
  it("puts __dirname first, so a stray node_modules/npm in the user's cwd can never shadow libi's vendored one", () => {
    // `bin/libi.js` only chdirs to the checkout root in a DEV checkout
    // (`inDevCheckout()`) — for a real `npx libi` install the cwd is whatever
    // directory the user happened to run the command from. If that directory
    // contains an unrelated `node_modules/npm` (e.g. run from inside another
    // npm project), anchoring cwd first would silently resolve THAT npm
    // instead of libi's pinned one. `__dirname` always points inside libi's
    // own tree in every non-bundled runtime, so it must be tried first.
    // Note: this asserts against `lib/install/npm-root.ts`'s OWN `__dirname`
    // (the module under test), not this test file's — the two differ, which
    // is exactly the point: the anchor is wherever libi's own code lives, not
    // wherever the caller happens to be.
    const anchors = npmResolveAnchors("/some/app/root");
    expect(anchors[0]).not.toBe("/some/app/root");
    expect(anchors[0]).toBe(path.join(process.cwd(), "lib", "install"));
  });

  it("keeps cwd as a second, bundled-runtime fallback behind it", () => {
    // In a bundled build Turbopack replaces `__dirname` with the build-time
    // placeholder "/ROOT/lib/install", which does not exist at runtime — that
    // candidate fails resolveVendoredNpmCli's existsSync check and falls
    // through to cwd, which IS the packaged app root there. So cwd must stay
    // as the second candidate for packaged behaviour to be unchanged.
    expect(npmResolveAnchors("/some/app/root")).toContain("/some/app/root");
    expect(npmResolveAnchors("/some/app/root").length).toBeGreaterThan(1);
  });

  it("de-duplicates so a repeated anchor isn't probed twice", () => {
    const anchors = npmResolveAnchors(__dirname);
    expect(anchors).toEqual([...new Set(anchors)]);
  });

  it("resolves npm from this checkout's real __dirname anchor", () => {
    // The end-to-end guarantee: from the anchor these tests run under, the
    // vendored npm CLI is genuinely findable on disk.
    const requireFrom = createRequire(path.join(npmResolveAnchors()[0], "noop.js"));
    const cli = path.join(
      path.dirname(requireFrom.resolve("npm/package.json")),
      "bin",
      "npm-cli.js",
    );
    expect(existsSync(cli)).toBe(true);
  });
});

describe("npmInstallArgs", () => {
  it("keeps the exact flag set both runners depend on", () => {
    // Shared by the execFile and utilityProcess paths so they can never drift.
    // `--ignore-scripts` in particular is the supply-chain RCE guard — losing
    // it silently would let any transitive dependency run code at install time.
    expect(npmInstallArgs("/tmp/root")).toEqual([
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      "--prefix",
      "/tmp/root",
    ]);
  });
});

/**
 * End-to-end proof that the plain-Node runner still genuinely executes the
 * vendored npm CLI — the path `npx libi` uses, which this change must not
 * alter. These spawn real npm against a temp root; both cases resolve offline
 * in well under a second (verified: empty manifest "up to date in 97ms", bad
 * spec fails at EINVALIDTAGNAME before any network call).
 */
describe("runNpmInstall on the plain-Node (execFile) runner", () => {
  it("actually installs into the root's node_modules, not just resolving", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "npm-root-run-"));
    // A `file:` dependency exercises a REAL install (npm materialises
    // node_modules) with no registry access, so this stays hermetic.
    mkdirSync(path.join(dir, "local-pkg"));
    writeFileSync(
      path.join(dir, "local-pkg", "package.json"),
      JSON.stringify({ name: "libi-fixture-pkg", version: "1.0.0" }),
    );
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "libi-npm-root-test",
        private: true,
        version: "0.0.0",
        dependencies: { "libi-fixture-pkg": "file:./local-pkg" },
      }),
    );

    await expect(
      runNpmInstall(dir, { timeoutMs: 120_000, logTag: "test-install" }),
    ).resolves.toBeUndefined();

    // The decisive assertion: npm genuinely ran and populated the root. If the
    // runner ever spawns something that ISN'T npm — the exact packaged-Electron
    // bug this change fixes — this directory stays empty.
    expect(existsSync(path.join(dir, "node_modules", "libi-fixture-pkg"))).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("rejects with execFile's 'Command failed:' shape when npm exits non-zero", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "npm-root-fail-"));
    // An invalid version spec makes npm exit non-zero immediately, offline.
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "libi-npm-root-test",
        private: true,
        version: "0.0.0",
        dependencies: { x: "@@@not-a-spec@@@" },
      }),
    );

    // Callers (`lib/mcp/bundled-install.ts`, `lib/agents/runtime-install.ts`)
    // only stringify `err.message`, so the `Command failed:` prefix is the
    // contract the utilityProcess runner's `npmFailure` deliberately mirrors.
    await expect(
      runNpmInstall(dir, { timeoutMs: 120_000, logTag: "test-install" }),
    ).rejects.toThrow(/^Command failed:/);

    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});

/**
 * A fake `UtilityProcess` for exercising `runNpmViaUtilityProcess`'s
 * timer/settle logic under plain Node — real Electron doesn't exist in the
 * test runtime, which is exactly why the function takes `fork` as an
 * injectable parameter (see `UtilityProcessForkFn`).
 */
class FakeUtilityProcess extends EventEmitter implements UtilityProcessLike {
  readonly stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
  readonly stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;
  killCalls = 0;

  kill(): boolean {
    this.killCalls++;
    return true;
  }
}

/**
 * `runNpmViaUtilityProcess` is the fix for two things at once, both covered
 * here against a fake child (no real Electron needed, per Finding 5):
 *
 * 1. It owns its own timeout (`utilityProcess` has none built in) and must
 *    kill + reject immediately rather than waiting on `exit`.
 * 2. It must never let an Electron `'error'` event (Finding 1 — emitted on a
 *    non-continuable V8 fault, e.g. the npm child OOMing on a low-RAM
 *    machine) go unhandled: with no listener, `'error'` on an EventEmitter
 *    THROWS instead of being ignored, taking down the whole Electron main
 *    process with no diagnostic instead of rejecting cleanly.
 */
describe("runNpmViaUtilityProcess", () => {
  const npmCli = "/fake/npm-cli.js";
  const args = ["install", "--prefix", "/fake/root"];
  const baseOpts = { cwd: "/fake/root", env: {} as Record<string, string>, timeoutMs: 5_000 };

  it("kills the child and rejects when the timeout fires before 'exit'", async () => {
    const child = new FakeUtilityProcess();
    const fork: UtilityProcessForkFn = () => child;

    const promise = runNpmViaUtilityProcess(npmCli, args, { ...baseOpts, timeoutMs: 15 }, fork);

    // A child that never emits 'exit' (hung/ignoring SIGTERM) must not be
    // able to hang the install — the precise failure this runner exists to
    // remove.
    await expect(promise).rejects.toThrow(/timed out after 15ms/);
    expect(child.killCalls).toBe(1);
  });

  it("rejects with the exit-code shape on a non-zero exit", async () => {
    const child = new FakeUtilityProcess();
    const fork: UtilityProcessForkFn = () => child;

    const promise = runNpmViaUtilityProcess(npmCli, args, baseOpts, fork);
    child.emit("exit", 1);

    await expect(promise).rejects.toThrow(/exited with code 1/);
  });

  it("resolves on a zero exit", async () => {
    const child = new FakeUtilityProcess();
    const fork: UtilityProcessForkFn = () => child;

    const promise = runNpmViaUtilityProcess(npmCli, args, baseOpts, fork);
    child.stdout.emit("data", Buffer.from("up to date\n"));
    child.emit("exit", 0);

    await expect(promise).resolves.toEqual({ stdout: "up to date\n", stderr: "" });
  });

  it("rejects (not throws) when Electron emits a non-continuable 'error' event — Finding 1", async () => {
    const child = new FakeUtilityProcess();
    const fork: UtilityProcessForkFn = () => child;

    const promise = runNpmViaUtilityProcess(npmCli, args, baseOpts, fork);

    // Electron's real signature: `(type: 'FatalError', location: string, report: string)`.
    // Before the fix there was no listener at all, so this `emit` would have
    // thrown synchronously right here instead of the promise rejecting.
    expect(() => child.emit("error", "FatalError", "electron/utility.cc:123", "{}")).not.toThrow();

    await expect(promise).rejects.toThrow(/FatalError/);
    await expect(promise).rejects.toThrow(/electron\/utility\.cc:123/);
  });

  it("holds the double-settle guard when 'exit' follows 'error' (Electron's documented ordering)", async () => {
    const child = new FakeUtilityProcess();
    const fork: UtilityProcessForkFn = () => child;

    const promise = runNpmViaUtilityProcess(npmCli, args, baseOpts, fork);

    child.emit("error", "FatalError", "electron/utility.cc:123", "{}");
    // Electron's docs: "No matter if you listen to the `error` event, the
    // `exit` event will be emitted after the child process terminates." A
    // second settle attempt from a resolving `exit` must be a no-op — the
    // rejection reason must stay the error's, not flip to a resolve.
    child.emit("exit", 0);

    await expect(promise).rejects.toThrow(/FatalError/);
  });
});
