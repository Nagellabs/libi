import { describe, it, expect, vi, afterEach } from "vitest";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import type { BundledDependency } from "@/mcp/registry/types";

/**
 * Regression guard for the Apple-Silicon "silent no-audio" bug: the bundled
 * ffmpeg/ffprobe macOS download pointed at evermeet.cx (x86_64-only), so on
 * arm64 without Rosetta the binaries could not execute. probeMedia() then
 * swallowed the exec failure, every video landed with hasAudio=false, and no
 * inline audio clips were created. Two defects are covered here:
 *   1. darwin download must be arch-keyed (arm64 → an aarch64 build).
 *   2. an installed-but-unrunnable binary (wrong arch) must NOT verify green.
 */

const core = BUNDLED_MCP_SERVERS.find((m) => m.core);

function coreDep(binary: string): BundledDependency {
  const dep = core!.dependencies.find((d) => d.binary === binary);
  if (!dep) throw new Error(`core dep ${binary} not found`);
  return dep;
}

describe("ffmpeg/ffprobe darwin download is arch-keyed", () => {
  it("the core libi MCP hosts ffmpeg + ffprobe", () => {
    expect(core).toBeDefined();
    expect(core!.dependencies.map((d) => d.binary)).toEqual(
      expect.arrayContaining(["ffmpeg", "ffprobe"]),
    );
  });

  for (const binary of ["ffmpeg", "ffprobe"] as const) {
    describe(binary, () => {
      it("darwin downloadUrl is an arch object with arm64 + x64", () => {
        const dep = coreDep(binary);
        const darwin = dep.downloadUrl?.darwin;
        expect(typeof darwin).toBe("object");
        const obj = darwin as Record<string, string>;
        expect(obj.arm64).toBeTruthy();
        expect(obj.x64).toBeTruthy();
      });

      it("arm64 points at an aarch64/arm64 macOS build (not evermeet x86_64)", () => {
        const obj = coreDep(binary).downloadUrl!.darwin as Record<
          string,
          string
        >;
        expect(obj.arm64).toContain("arm64");
        expect(obj.arm64).not.toContain("evermeet.cx");
        expect(obj.arm64).toContain(binary); // ffmpeg.zip / ffprobe.zip
      });

      it("x64 stays on evermeet.cx (Intel Macs)", () => {
        const obj = coreDep(binary).downloadUrl!.darwin as Record<
          string,
          string
        >;
        expect(obj.x64).toContain("evermeet.cx");
      });

      it("linux/win32 remain plain strings (unchanged)", () => {
        const dep = coreDep(binary);
        expect(typeof dep.downloadUrl?.linux).toBe("string");
        expect(typeof dep.downloadUrl?.win32).toBe("string");
      });

      it("declares a runCheck so an unrunnable binary is caught", () => {
        expect(coreDep(binary).runCheck).toEqual(["-version"]);
      });

      it("install token is at or past the arch fix, so wrong-arch installs re-fetch", () => {
        // A FLOOR, not an exact match. This test guards the arch fix: the token
        // must not regress below the date that forced those re-installs. Pinning
        // the exact value made every later, unrelated source change fail here —
        // it broke when the Linux drawtext fix (2026-08-16) bumped it, which is
        // a bump this test has no opinion about. ISO dates sort lexicographically.
        const token = coreDep(binary).pinnedInstallToken;
        expect(typeof token).toBe("string");
        expect(token! >= "2026-07-24").toBe(true);
      });
    });
  }
});

describe("DependencyManager runnability probe", () => {
  afterEach(() => vi.restoreAllMocks());

  // isBinaryRunnable is a private static; reach it through the class.
  const isRunnable = (bin: string, args: string[]): Promise<boolean> =>
    (
      DependencyManager as unknown as {
        isBinaryRunnable(b: string, a: string[]): Promise<boolean>;
      }
    ).isBinaryRunnable(bin, args);

  it("returns true for a binary that actually executes", async () => {
    // node itself always runs on this host — the positive control.
    await expect(isRunnable(process.execPath, ["--version"])).resolves.toBe(
      true,
    );
  });

  it("returns false when the binary cannot be spawned (wrong-arch analogue)", async () => {
    // A path that can't exec stands in for a 'bad CPU type' arm64/x86_64 mismatch.
    await expect(
      isRunnable("/nonexistent/definitely-not-a-real-binary-xyz", ["-version"]),
    ).resolves.toBe(false);
  });

  it("resolveStatusAsync downgrades an installed-but-unrunnable binary to pending", async () => {
    const mgr = new DependencyManager();
    const dep = { binary: "ffmpeg", runCheck: ["-version"] } as BundledDependency;

    vi.spyOn(
      mgr as unknown as { resolveStatus(d: BundledDependency): unknown },
      "resolveStatus",
    ).mockReturnValue({
      binary: "ffmpeg",
      installed: true,
      path: "/fake/bin/ffmpeg",
      source: "bundled",
      runtimeStatus: "installed",
    });
    vi.spyOn(
      DependencyManager as unknown as {
        isBinaryRunnable(b: string, a: string[]): Promise<boolean>;
      },
      "isBinaryRunnable",
    ).mockResolvedValue(false);

    const status = await (
      mgr as unknown as {
        resolveStatusAsync(d: BundledDependency): Promise<{
          installed: boolean;
          runtimeStatus: string;
          path: string | null;
        }>;
      }
    ).resolveStatusAsync(dep);

    expect(status.installed).toBe(false);
    expect(status.runtimeStatus).toBe("pending");
    expect(status.path).toBeNull();
  });

  it("resolveStatusAsync keeps a runnable binary installed", async () => {
    const mgr = new DependencyManager();
    const dep = { binary: "ffmpeg", runCheck: ["-version"] } as BundledDependency;

    vi.spyOn(
      mgr as unknown as { resolveStatus(d: BundledDependency): unknown },
      "resolveStatus",
    ).mockReturnValue({
      binary: "ffmpeg",
      installed: true,
      path: "/fake/bin/ffmpeg",
      source: "bundled",
      runtimeStatus: "installed",
    });
    vi.spyOn(
      DependencyManager as unknown as {
        isBinaryRunnable(b: string, a: string[]): Promise<boolean>;
      },
      "isBinaryRunnable",
    ).mockResolvedValue(true);

    const status = await (
      mgr as unknown as {
        resolveStatusAsync(d: BundledDependency): Promise<{ installed: boolean }>;
      }
    ).resolveStatusAsync(dep);

    expect(status.installed).toBe(true);
  });

  it("resolveStatusAsync never execs when the dep has no runCheck", async () => {
    const mgr = new DependencyManager();
    const dep = { binary: "some-tool" } as BundledDependency;

    vi.spyOn(
      mgr as unknown as { resolveStatus(d: BundledDependency): unknown },
      "resolveStatus",
    ).mockReturnValue({
      binary: "some-tool",
      installed: true,
      path: "/fake/bin/some-tool",
      source: "bundled",
      runtimeStatus: "installed",
    });
    const runSpy = vi.spyOn(
      DependencyManager as unknown as {
        isBinaryRunnable(b: string, a: string[]): Promise<boolean>;
      },
      "isBinaryRunnable",
    );

    const status = await (
      mgr as unknown as {
        resolveStatusAsync(d: BundledDependency): Promise<{ installed: boolean }>;
      }
    ).resolveStatusAsync(dep);

    expect(status.installed).toBe(true);
    expect(runSpy).not.toHaveBeenCalled();
  });
});
