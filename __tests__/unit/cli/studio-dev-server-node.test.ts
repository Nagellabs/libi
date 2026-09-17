import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `next dev`'s Node ABI coupling: `predev`
 * (`scripts/ensure-native-modules.js`) rebuilds `better-sqlite3` for
 * `process.execPath` — the SHELL's node — but the dev branch of
 * `lib/cli/studio.ts` used to spawn `next dev` under
 * `resolveNodeCommand()`'s libi-managed node unconditionally. If the two
 * have drifted to different majors, `next dev`'s first DB call throws an ABI
 * mismatch. `bin/libi.js` now forwards its own `process.execPath` as
 * `LIBI_LAUNCHER_NODE`, and `resolveDevServerNodeCommand()` (exported from
 * `lib/cli/studio.ts`) prefers it over `resolveNodeCommand()` when it points
 * at a file that exists, falling back otherwise.
 *
 * This mirrors `studio-boot-order.test.ts`'s mocking of `spawn`,
 * `runInstallPhase`, `createRequire` and `resolveNodeCommand`, but focuses
 * on which node binary the dev branch hands to `spawn`.
 */

vi.mock("@/lib/server/lifecycle", () => ({
  runInstallPhase: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/server/lifecycle/adapters/cli", () => ({
  cliAdapter: vi.fn(() => ({})),
}));

// Fire-and-forget in the production branch of `startStudio`, called
// unconditionally before `runProductionServer`. Mocked so the
// production-path test below (which drives that branch for real, to prove
// `resolveDevServerNodeCommand()` is unreachable there) never makes a real
// network request.
vi.mock("@/lib/cli/update-notice", () => ({
  maybePrintUpdateNotice: vi.fn(async () => null),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => ({ on: vi.fn() })),
  };
});

const FAKE_NEXT_BIN = "/fake-project-root/node_modules/next/dist/bin/next";
const resolveNextBin = vi.fn(() => FAKE_NEXT_BIN);
vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: vi.fn(() => ({ resolve: resolveNextBin })),
  };
});

/** The libi-managed node `resolveNodeCommand()` would pick when
 *  `LIBI_LAUNCHER_NODE` is unset or missing — distinct from any real path on
 *  the test machine so the two fallback tests can't pass by accident. */
const FAKE_MANAGED_NODE = "/fake/libi/bin/node";
const resolveNodeCommandMock = vi.fn(() => FAKE_MANAGED_NODE);
vi.mock("@/lib/runtime/node-runtime", () => ({
  resolveNodeCommand: () => resolveNodeCommandMock(),
}));

import { startStudio, resolveDevServerNodeCommand } from "@/lib/cli/studio";
import { spawn } from "node:child_process";

function makeDevCheckoutLayout(): { dirname: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-studio-dev-node-"));
  fs.writeFileSync(path.join(root, ".git"), "");
  const dirname = path.join(root, "lib", "cli");
  return { dirname, root };
}

/** A fake "installed package" layout: no `.git` anywhere under a fresh temp
 *  root, with a `package.json` marker so `inDevCheckout`'s upward walk stops
 *  deterministically there — matches `makeInstalledLayout` in
 *  `studio-boot-order.test.ts`. */
function makeInstalledLayout(): { dirname: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-studio-installed-node-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const dirname = path.join(root, "lib", "cli");
  return { dirname, root };
}

describe("resolveDevServerNodeCommand()", () => {
  const originalEnv = process.env.LIBI_LAUNCHER_NODE;
  let realExistingFile: string;
  let tmpDir: string;

  beforeEach(() => {
    resolveNodeCommandMock.mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-launcher-node-file-"));
    realExistingFile = path.join(tmpDir, "node");
    fs.writeFileSync(realExistingFile, "");
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.LIBI_LAUNCHER_NODE;
    else process.env.LIBI_LAUNCHER_NODE = originalEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prefers LIBI_LAUNCHER_NODE when it points at a file that exists", () => {
    process.env.LIBI_LAUNCHER_NODE = realExistingFile;

    expect(resolveDevServerNodeCommand()).toBe(realExistingFile);
    expect(resolveNodeCommandMock).not.toHaveBeenCalled();
  });

  it("falls back to resolveNodeCommand() when LIBI_LAUNCHER_NODE is unset", () => {
    delete process.env.LIBI_LAUNCHER_NODE;

    expect(resolveDevServerNodeCommand()).toBe(FAKE_MANAGED_NODE);
    expect(resolveNodeCommandMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to resolveNodeCommand() when LIBI_LAUNCHER_NODE points at a missing file", () => {
    process.env.LIBI_LAUNCHER_NODE = path.join(tmpDir, "does-not-exist");

    expect(resolveDevServerNodeCommand()).toBe(FAKE_MANAGED_NODE);
    expect(resolveNodeCommandMock).toHaveBeenCalledTimes(1);
  });
});

describe("startStudio dev branch spawns next dev under resolveDevServerNodeCommand()", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const originalCwd = process.cwd();
  const originalLauncherNode = process.env.LIBI_LAUNCHER_NODE;
  const tempDirs: string[] = [];
  const signalListenersAtStart = new Map(
    (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((s) => [s, process.listeners(s)]),
  );

  beforeEach(() => {
    vi.mocked(spawn).mockClear();
    resolveNextBin.mockReset();
    resolveNextBin.mockImplementation(() => FAKE_NEXT_BIN);
    resolveNodeCommandMock.mockClear();
    delete process.env.LIBI_LAUNCHER_NODE;
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
    if (originalLauncherNode === undefined) delete process.env.LIBI_LAUNCHER_NODE;
    else process.env.LIBI_LAUNCHER_NODE = originalLauncherNode;
    exitSpy.mockRestore();
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

  it("spawns next dev under LIBI_LAUNCHER_NODE when it is set to an existing file", async () => {
    const { dirname, root } = makeDevCheckoutLayout();
    tempDirs.push(root);
    const launcherNode = path.join(root, "shell-node");
    fs.writeFileSync(launcherNode, "");
    process.env.LIBI_LAUNCHER_NODE = launcherNode;

    await startStudio("3456", { dirname });

    expect(spawn).toHaveBeenCalledWith(
      launcherNode,
      [FAKE_NEXT_BIN, "dev", "--port", "3456", "-H", "127.0.0.1"],
      expect.objectContaining({ cwd: originalCwd }),
    );
    expect(resolveNodeCommandMock).not.toHaveBeenCalled();
  });

  it("falls back to resolveNodeCommand() when LIBI_LAUNCHER_NODE is unset", async () => {
    const { dirname, root } = makeDevCheckoutLayout();
    tempDirs.push(root);
    delete process.env.LIBI_LAUNCHER_NODE;

    await startStudio("3456", { dirname });

    expect(spawn).toHaveBeenCalledWith(
      FAKE_MANAGED_NODE,
      [FAKE_NEXT_BIN, "dev", "--port", "3456", "-H", "127.0.0.1"],
      expect.objectContaining({ cwd: originalCwd }),
    );
  });

  it("falls back to resolveNodeCommand() when LIBI_LAUNCHER_NODE points at a missing file", async () => {
    const { dirname, root } = makeDevCheckoutLayout();
    tempDirs.push(root);
    process.env.LIBI_LAUNCHER_NODE = path.join(root, "no-such-node-binary");

    await startStudio("3456", { dirname });

    expect(spawn).toHaveBeenCalledWith(
      FAKE_MANAGED_NODE,
      [FAKE_NEXT_BIN, "dev", "--port", "3456", "-H", "127.0.0.1"],
      expect.objectContaining({ cwd: originalCwd }),
    );
  });

  it("prefers LIBI_LAUNCHER_NODE on win32 too", async () => {
    const { dirname, root } = makeDevCheckoutLayout();
    tempDirs.push(root);
    const launcherNode = path.join(root, "shell-node.exe");
    fs.writeFileSync(launcherNode, "");
    process.env.LIBI_LAUNCHER_NODE = launcherNode;

    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...realPlatform, value: "win32" });
    try {
      await startStudio("3456", { dirname });
    } finally {
      Object.defineProperty(process, "platform", realPlatform);
    }

    expect(spawn).toHaveBeenCalledWith(
      launcherNode,
      [FAKE_NEXT_BIN, "dev", "--port", "3456", "-H", "127.0.0.1"],
      expect.objectContaining({ cwd: originalCwd }),
    );
  });
});

/**
 * Pins the fact `resolveDevServerNodeCommand`'s own doc comment leans on:
 * that branch "only runs for a dev checkout today." Drives `startStudio()`
 * with the dev-checkout signal false (a real installed-layout fixture, not a
 * mock of `inDevCheckout` itself) all the way into the production branch,
 * and proves neither `LIBI_LAUNCHER_NODE` nor `resolveNodeCommand()` is ever
 * consulted there, and `next dev` is never spawned. `ensureNextExternalSymlinks`
 * is left unmocked and allowed to throw its real "manifest missing" error
 * (there is no `.next` build under the fake project root) — that failure is
 * itself the proof the real production path was taken, not a stand-in for
 * it, and it happens before any port is bound or `next()` is imported.
 */
describe("startStudio production (not-dev-checkout) path never touches resolveDevServerNodeCommand()", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let existsSpy: ReturnType<typeof vi.spyOn>;
  const originalCwd = process.cwd();
  const originalLauncherNode = process.env.LIBI_LAUNCHER_NODE;
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.mocked(spawn).mockClear();
    resolveNodeCommandMock.mockClear();
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`__EXIT_${code}__`);
      }) as never);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    existsSpy = vi.spyOn(fs, "existsSync");
  });

  afterEach(() => {
    if (originalLauncherNode === undefined) delete process.env.LIBI_LAUNCHER_NODE;
    else process.env.LIBI_LAUNCHER_NODE = originalLauncherNode;
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    existsSpy.mockRestore();
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

  it("never reads LIBI_LAUNCHER_NODE, never calls resolveNodeCommand(), and never spawns next dev", async () => {
    const { dirname, root } = makeInstalledLayout();
    tempDirs.push(root);
    // Set to a real, existing file — if `resolveDevServerNodeCommand()` were
    // ever reached here, it would happily resolve to this path, so its
    // absence from every assertion below is not a coincidence of a missing file.
    const launcherNode = path.join(root, "shell-node");
    fs.writeFileSync(launcherNode, "");
    process.env.LIBI_LAUNCHER_NODE = launcherNode;

    await expect(startStudio("3456", { dirname })).rejects.toThrow("__EXIT_1__");

    // Reached the real production path — `ensureNextExternalSymlinks` threw
    // on the missing build — not some unrelated early exit.
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Next.js externals manifest"),
    );
    // The dev-only spawn (`next dev` under `resolveDevServerNodeCommand()`)
    // was never reached.
    expect(spawn).not.toHaveBeenCalled();
    expect(resolveNodeCommandMock).not.toHaveBeenCalled();
    // `resolveDevServerNodeCommand()`'s one and only `fs` call in this
    // module — never made against the launcher path for production.
    expect(existsSpy).not.toHaveBeenCalledWith(launcherNode);
  });
});
