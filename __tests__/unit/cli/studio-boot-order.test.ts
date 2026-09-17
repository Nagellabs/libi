import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Regression coverage for the re-review finding: `startStudio` used to chdir
// to the resolved project root INSIDE `runProductionServer`, which is called
// AFTER `runInstallPhase` (Category A). Any installer that walks up from
// `process.cwd()` (`lib/playwright/paths.ts#resolvePlaywrightCoreCli` did,
// and Chromium came back to the install path via export; today's
// ffmpeg/ffprobe/node installers anchor on LIBI_HOME) then ran against the
// ORIGINAL launch cwd, not the package root — a hard Category A failure on a
// fresh machine.
// These tests prove the chdir now happens before `runInstallPhase` is
// invoked for a non-dev-checkout launch, and that the dev-checkout branch is
// completely unaffected (no chdir, `next dev` still spawns with
// `cwd: process.cwd()`).

const capturedInstallCwds: string[] = [];

vi.mock("@/lib/server/lifecycle", () => ({
  runInstallPhase: vi.fn(async () => {
    capturedInstallCwds.push(process.cwd());
    return { ok: false };
  }),
}));

vi.mock("@/lib/server/lifecycle/adapters/cli", () => ({
  cliAdapter: vi.fn(() => ({})),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => ({ on: vi.fn() })),
  };
});

/** The dev branch resolves Next's own CLI via `createRequire(...).resolve(...)`
 *  anchored at the project root — stubbed here so the test doesn't depend on
 *  a real `node_modules/next` existing under the fake project roots below. */
const FAKE_NEXT_BIN = "/fake-project-root/node_modules/next/dist/bin/next";
const resolveNextBin = vi.fn(() => FAKE_NEXT_BIN);
vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: vi.fn(() => ({ resolve: resolveNextBin })),
  };
});

/** Never `process.execPath` under Electron — see
 *  `__tests__/unit/uv-env/install-path-invariants.test.ts`. Stubbed to a
 *  deterministic fake so the assertions below don't depend on whether this
 *  machine happens to have a libi-managed node under `~/.libi/bin`. */
const FAKE_NODE_COMMAND = "/fake/libi/bin/node";
vi.mock("@/lib/runtime/node-runtime", () => ({
  resolveNodeCommand: () => FAKE_NODE_COMMAND,
}));

import { startStudio } from "@/lib/cli/studio";
import { runInstallPhase } from "@/lib/server/lifecycle";
import { spawn } from "node:child_process";

/** A fake "installed package" layout: no `.git` anywhere under a fresh temp
 *  root, with a `package.json` marker so `inDevCheckout`'s upward walk stops
 *  deterministically there instead of continuing into real ancestor
 *  directories on the test machine. */
function makeInstalledLayout(): { dirname: string; projectRoot: string } {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "libi-studio-installed-"),
  );
  fs.writeFileSync(path.join(projectRoot, "package.json"), "{}");
  const dirname = path.join(projectRoot, "lib", "cli");
  return { dirname, projectRoot };
}

/** A fake "dev checkout" layout: a `.git` marker at the root so
 *  `inDevCheckout` reports true, exactly like a real git checkout would. */
function makeDevCheckoutLayout(): { dirname: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-studio-dev-"));
  fs.writeFileSync(path.join(root, ".git"), "");
  const dirname = path.join(root, "lib", "cli");
  return { dirname, root };
}

/** The env the dev branch handed to `npx next dev`. */
function spawnedEnv(): NodeJS.ProcessEnv {
  const options = vi.mocked(spawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
  return options.env;
}

describe("startStudio boot-order (Important-1 regression)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const originalCwd = process.cwd();
  const tempDirs: string[] = [];
  // The dev branch keeps the CLI alive through Ctrl-C with listeners on this
  // very process; a forked test worker must not keep them.
  const signalListenersAtStart = new Map(
    (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((s) => [s, process.listeners(s)]),
  );

  beforeEach(() => {
    capturedInstallCwds.length = 0;
    vi.mocked(spawn).mockClear();
    resolveNextBin.mockReset();
    resolveNextBin.mockImplementation(() => FAKE_NEXT_BIN);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`__EXIT_${code}__`);
      }) as never);
  });

  afterEach(() => {
    for (const [signal, kept] of signalListenersAtStart) {
      for (const listener of process.listeners(signal)) {
        if (!kept.includes(listener)) process.removeListener(signal, listener);
      }
    }
    vi.unstubAllEnvs();
    exitSpy.mockRestore();
    // Belt-and-suspenders: restore the real cwd regardless of which branch
    // ran, then clean up every temp dir created this test.
    try {
      process.chdir(originalCwd);
    } catch {
      /* ignore */
    }
    while (tempDirs.length) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chdirs to the resolved project root BEFORE runInstallPhase (Category A) runs, for a non-dev-checkout launch", async () => {
    const { dirname, projectRoot } = makeInstalledLayout();
    tempDirs.push(projectRoot);

    await expect(
      startStudio("3456", { dirname }),
    ).rejects.toThrow("__EXIT_1__");

    expect(runInstallPhase).toHaveBeenCalledTimes(1);
    expect(capturedInstallCwds).toHaveLength(1);
    expect(fs.realpathSync(capturedInstallCwds[0])).toBe(
      fs.realpathSync(projectRoot),
    );
    // The production server-spawn path (`spawn("npx", ["next", "dev", ...])`)
    // must NOT be reached for a non-dev-checkout launch.
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does NOT chdir for a dev-checkout launch — Category A runs with the original cwd, and next dev spawns with cwd: process.cwd()", async () => {
    const { dirname, root } = makeDevCheckoutLayout();
    tempDirs.push(root);

    vi.mocked(runInstallPhase).mockImplementationOnce(async () => {
      capturedInstallCwds.push(process.cwd());
      return { ok: true };
    });

    const sigintListenersBefore = process.listenerCount("SIGINT");
    await startStudio("3456", { dirname });

    // The CLI now outlives a Ctrl-C until `next dev` has exited, instead of
    // dying on it and taking the server's shutdown with it.
    expect(process.listenerCount("SIGINT")).toBe(sigintListenersBefore + 1);
    expect(capturedInstallCwds).toHaveLength(1);
    expect(capturedInstallCwds[0]).toBe(originalCwd);
    expect(spawn).toHaveBeenCalledTimes(1);
    // `-H 127.0.0.1` is load-bearing, not incidental: it's the loopback fix
    // from 55316e6a/e96f6c9f (a bare `next dev --port` binds every
    // interface). This assertion is a second, behavioural line of defence
    // for that fix alongside `__tests__/unit/security/server-bind.test.ts`
    // — do not "simplify" it back down to `["next", "dev", "--port", "3456"]`.
    // The spawned command is a real Node (`resolveNodeCommand()`) + Next's
    // own resolved bin, never `npx` — see this file's Windows-ENOENT test
    // below for why (spawning `npx`/`npx.cmd` fails on Windows either way).
    expect(spawn).toHaveBeenCalledWith(
      FAKE_NODE_COMMAND,
      [FAKE_NEXT_BIN, "dev", "--port", "3456", "-H", "127.0.0.1"],
      expect.objectContaining({ cwd: originalCwd }),
    );
    // Never chdir'd away from the original cwd.
    expect(process.cwd()).toBe(originalCwd);
  });

  it("spawns next dev with resolveNodeCommand() and Next's own resolved bin even on win32 — the `spawn npx ENOENT` fix", async () => {
    const { dirname, root } = makeDevCheckoutLayout();
    tempDirs.push(root);
    vi.mocked(runInstallPhase).mockImplementationOnce(async () => ({ ok: true }));

    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...realPlatform, value: "win32" });
    try {
      await startStudio("3456", { dirname });
    } finally {
      Object.defineProperty(process, "platform", realPlatform);
    }

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      FAKE_NODE_COMMAND,
      [FAKE_NEXT_BIN, "dev", "--port", "3456", "-H", "127.0.0.1"],
      expect.objectContaining({ cwd: originalCwd }),
    );
    // Never `"npx"` / `"npx.cmd"` — the whole point of the fix.
    expect(vi.mocked(spawn).mock.calls[0][0]).not.toMatch(/npx/i);
  });

  it("prints one clear stderr line and exits 1 when Next's own CLI can't be resolved from the project root", async () => {
    const { dirname, root } = makeDevCheckoutLayout();
    tempDirs.push(root);
    vi.mocked(runInstallPhase).mockImplementationOnce(async () => ({ ok: true }));
    resolveNextBin.mockImplementationOnce(() => {
      throw new Error("Cannot find module 'next/dist/bin/next'");
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(startStudio("3456", { dirname })).rejects.toThrow("__EXIT_1__");

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[libi]"),
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cannot find module 'next/dist/bin/next'"),
    );
    expect(spawn).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it("gives next dev's server 5 s to finish its own shutdown instead of Next's 100 ms, unless the developer exported a value", async () => {
    // `next dev` SIGKILLs its server NEXT_EXIT_TIMEOUT_MS after passing it a
    // signal. At Next's default the server's shutdown is cut off on every Ctrl-C.
    vi.mocked(runInstallPhase)
      .mockImplementationOnce(async () => ({ ok: true }))
      .mockImplementationOnce(async () => ({ ok: true }));

    const first = makeDevCheckoutLayout();
    tempDirs.push(first.root);
    vi.stubEnv("NEXT_EXIT_TIMEOUT_MS", undefined);
    await startStudio("3456", { dirname: first.dirname });
    expect(spawnedEnv().NEXT_EXIT_TIMEOUT_MS).toBe("5000");

    vi.mocked(spawn).mockClear();
    const second = makeDevCheckoutLayout();
    tempDirs.push(second.root);
    vi.stubEnv("NEXT_EXIT_TIMEOUT_MS", "800");
    await startStudio("3456", { dirname: second.dirname });
    expect(spawnedEnv().NEXT_EXIT_TIMEOUT_MS).toBe("800");
  });
});
