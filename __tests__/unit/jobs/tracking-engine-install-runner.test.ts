/**
 * Drives `trackingEngineInstallRunner.run()` end to end against a MOCKED
 * DependencyManager — this test must never run a real install (the real one
 * is ~2 GB of downloads and 10–20 minutes of uv sync).
 *
 * Same rationale as whisper-runner-progress.test.ts: the runner itself must
 * be WIRED to byte progress and to verify-before-success, not merely have
 * those helpers available in the codebase.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let venvDir: string;
let modelsDir: string;
let installed = false;

const retryDep = vi.fn();
const ensureDep = vi.fn();
/** Every DependencyManager call in the order the runner made it. */
let calls: string[] = [];

vi.mock("@/mcp/registry/dependency-manager", () => ({
  DependencyManager: class {
    ensureDep(mcpId: string, binary: string): Promise<void> {
      calls.push(`ensureDep:${mcpId}/${binary}`);
      return ensureDep(mcpId, binary);
    }
    retryDep(mcpId: string, binary: string): Promise<void> {
      calls.push(`retryDep:${mcpId}/${binary}`);
      return retryDep(mcpId, binary);
    }
  },
}));

vi.mock("@/lib/tracking/not-installed", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/tracking/not-installed")>();
  return { ...actual, trackingEngineInstalled: () => installed };
});

vi.mock("@/lib/tracking/engine-deps", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/tracking/engine-deps")>();
  return { ...actual, trackingModelsDir: () => modelsDir };
});

vi.mock("@/lib/uv-env/spawn-env", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/uv-env/spawn-env")>();
  return { ...actual, trackingVenvDir: () => venvDir };
});

interface Reported {
  done: number;
  total: number;
  unit: string;
}

function makeCtx(reported: Reported[]) {
  return {
    params: {},
    reportProgress: (done: number, total: number, unit: string) =>
      reported.push({ done, total, unit }),
    shouldCancel: () => false,
    checkpoint: vi.fn(),
    forced: false,
  };
}

describe("trackingEngineInstallRunner", () => {
  beforeEach(() => {
    venvDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-trk-venv-"));
    modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-trk-models-"));
    installed = false;
    retryDep.mockReset();
    ensureDep.mockReset();
    ensureDep.mockResolvedValue(undefined); // uv already on disk unless a test says otherwise
    calls = [];
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    fs.rmSync(venvDir, { recursive: true, force: true });
    fs.rmSync(modelsDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("short-circuits an already-installed engine without touching the installer", async () => {
    const { trackingEngineInstallRunner } = await import(
      "@/lib/jobs/runners/tracking-engine-install"
    );
    installed = true;
    const reported: Reported[] = [];
    const result = await trackingEngineInstallRunner.run(
      makeCtx(reported) as never,
    );
    expect(result).toEqual({ alreadyInstalled: true });
    expect(retryDep).not.toHaveBeenCalled();
  });

  it("refuses to run under LIBI_TEST_MODE", async () => {
    // Test mode fakes nothing about this install — without the guard, a
    // skill-eval scenario would silently spend ~2 GB and 20 minutes into a
    // throwaway LIBI_HOME.
    const { trackingEngineInstallRunner } = await import(
      "@/lib/jobs/runners/tracking-engine-install"
    );
    vi.stubEnv("LIBI_TEST_MODE", "1");
    await expect(
      trackingEngineInstallRunner.run(makeCtx([]) as never),
    ).rejects.toThrow(/test mode/);
    expect(retryDep).not.toHaveBeenCalled();
  });

  it("calls retryDep with the bundled.ts mcpId/binary and reports MB while bytes land", async () => {
    const { trackingEngineInstallRunner } = await import(
      "@/lib/jobs/runners/tracking-engine-install"
    );
    const reported: Reported[] = [];

    // Stand in for the tracking-pyenv installer: land bytes in BOTH
    // destination directories, then flip the installed marker — the runner
    // must pick the growth up from each of them.
    retryDep.mockImplementation(async () => {
      fs.writeFileSync(
        path.join(venvDir, "torch.so"),
        Buffer.alloc(60 * 1_000_000),
      );
      await vi.waitFor(
        () =>
          expect(
            reported.some((r) => r.unit === "MB" && r.done >= 59),
          ).toBe(true),
        { timeout: 5000 },
      );
      fs.writeFileSync(
        path.join(modelsDir, "yoloe11.onnx"),
        Buffer.alloc(40 * 1_000_000),
      );
      await vi.waitFor(
        () =>
          expect(
            reported.some((r) => r.unit === "MB" && r.done >= 99),
          ).toBe(true),
        { timeout: 5000 },
      );
      installed = true;
    });

    const result = await trackingEngineInstallRunner.run(
      makeCtx(reported) as never,
    );

    expect(result).toEqual({ alreadyInstalled: false });
    // The exact strings from mcp/registry/bundled.ts — the whole point of
    // going through retryDep is hitting the same dep the Settings UI does.
    expect(retryDep).toHaveBeenCalledWith("libi-tracking", "tracking-pyenv");
    expect(retryDep).toHaveBeenCalledTimes(1);

    // Progress is MB throughout, with movement between start and finish.
    expect(reported.every((r) => r.unit === "MB")).toBe(true);
    const mid = reported.filter((r) => r.done > 0 && r.done < r.total);
    expect(mid.length, "no intermediate progress was reported").toBeGreaterThan(
      0,
    );
    // Ends pinned at 100%.
    expect(reported.at(-1)!.done).toBe(reported.at(-1)!.total);
  });

  it("fails loudly when retryDep resolves but the install token never appears", async () => {
    // The defect-#59 lesson: the installer chain exiting cleanly is not
    // evidence the engine is installed. The runner must not write the token
    // itself and must not report success without it.
    const { trackingEngineInstallRunner } = await import(
      "@/lib/jobs/runners/tracking-engine-install"
    );
    retryDep.mockResolvedValue(undefined); // exits 0, installs nothing
    await expect(
      trackingEngineInstallRunner.run(makeCtx([]) as never),
    ).rejects.toThrow(/NOT installed/);
  });

  it("propagates a retryDep failure", async () => {
    const { trackingEngineInstallRunner } = await import(
      "@/lib/jobs/runners/tracking-engine-install"
    );
    retryDep.mockRejectedValue(new Error("uv sync failed"));
    await expect(
      trackingEngineInstallRunner.run(makeCtx([]) as never),
    ).rejects.toThrow(/uv sync failed/);
  });

  it("ensures uv (ensureDep, not retryDep) BEFORE the pyenv install", async () => {
    // The tracking-pyenv installer runs `uv sync --locked` through
    // `uvPath()`, which falls back to a bare "uv" when <LIBI_HOME>/bin/uv is
    // absent — ENOENT on a fresh machine without a system uv. `ensureMcp`
    // guarantees standard-before-custom inside its own loop, but this runner
    // calls retryDep on the pyenv dep directly and bypasses that loop, so it
    // must make the same guarantee itself. ensureDep, not retryDep: uv must
    // not be re-downloaded (52 MB) on every engine install attempt.
    const { trackingEngineInstallRunner } = await import(
      "@/lib/jobs/runners/tracking-engine-install"
    );
    retryDep.mockImplementation(async () => {
      installed = true;
    });
    await trackingEngineInstallRunner.run(makeCtx([]) as never);
    expect(ensureDep).toHaveBeenCalledWith("libi-tracking", "uv");
    expect(ensureDep).toHaveBeenCalledTimes(1);
    expect(retryDep).toHaveBeenCalledWith("libi-tracking", "tracking-pyenv");
    expect(retryDep).not.toHaveBeenCalledWith("libi-tracking", "uv");
    expect(calls).toEqual([
      "ensureDep:libi-tracking/uv",
      "retryDep:libi-tracking/tracking-pyenv",
    ]);
  });

  it("fails the job with a message naming uv when the uv install fails, without starting the pyenv", async () => {
    const { trackingEngineInstallRunner } = await import(
      "@/lib/jobs/runners/tracking-engine-install"
    );
    ensureDep.mockRejectedValue(new Error("fetch failed: github.com"));
    await expect(
      trackingEngineInstallRunner.run(makeCtx([]) as never),
    ).rejects.toThrow(/\buv\b.*fetch failed: github\.com/);
    expect(retryDep).not.toHaveBeenCalled();
  });
});
