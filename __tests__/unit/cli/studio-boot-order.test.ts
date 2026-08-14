import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Regression coverage for the re-review finding: `startStudio` used to chdir
// to the resolved project root INSIDE `runProductionServer`, which is called
// AFTER `runInstallPhase` (Category A). That left every cwd-relative
// resolution inside Category A (e.g.
// `mcp/registry/installers.ts#resolvePlaywrightCoreCli`, reached by the
// tier-1 `playwright-chromium` installer on any machine without Chromium
// already in playwright's shared cache) running against the ORIGINAL launch
// cwd, not the package root — a hard Category A failure on a fresh machine.
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

describe("startStudio boot-order (Important-1 regression)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const originalCwd = process.cwd();
  const tempDirs: string[] = [];

  beforeEach(() => {
    capturedInstallCwds.length = 0;
    vi.mocked(spawn).mockClear();
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`__EXIT_${code}__`);
      }) as never);
  });

  afterEach(() => {
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
      startStudio("3456", undefined, { dirname }),
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

    await startStudio("3456", undefined, { dirname });

    expect(capturedInstallCwds).toHaveLength(1);
    expect(capturedInstallCwds[0]).toBe(originalCwd);
    expect(spawn).toHaveBeenCalledTimes(1);
    // `-H 127.0.0.1` is load-bearing, not incidental: it's the loopback fix
    // from 55316e6a/e96f6c9f (a bare `next dev --port` binds every
    // interface). This assertion is a second, behavioural line of defence
    // for that fix alongside `__tests__/unit/security/server-bind.test.ts`
    // — do not "simplify" it back down to `["next", "dev", "--port", "3456"]`.
    expect(spawn).toHaveBeenCalledWith(
      "npx",
      ["next", "dev", "--port", "3456", "-H", "127.0.0.1"],
      expect.objectContaining({ cwd: originalCwd }),
    );
    // Never chdir'd away from the original cwd.
    expect(process.cwd()).toBe(originalCwd);
  });
});
