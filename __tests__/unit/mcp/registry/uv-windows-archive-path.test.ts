import { describe, it, expect } from "vitest";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import type { BundledDependency } from "@/mcp/registry/types";

/**
 * Regression guard for the Windows cold-boot failure found on the QA lab
 * (Windows 11, 2026-08-22): every bundled uv dep declared its win32 binary as
 *
 *   uv-x86_64-pc-windows-msvc/uv.exe
 *
 * by symmetry with the macOS and Linux entries. astral-sh does not publish it
 * that way. The unix builds are tarballs that unpack into a directory named
 * after the target; the Windows build is a zip with the executables at the
 * ROOT (uv.exe, uvw.exe, uvx.exe). Extraction therefore succeeded and the
 * glob lookup then found nothing, raising
 *
 *   Extracted file not found for uv: uv-x86_64-pc-windows-msvc/uv.exe
 *
 * uv is a tier-1 dep, so that aborted Category A and libi could not start on
 * Windows at all.
 *
 * Both halves are asserted deliberately. Pinning only the win32 value would
 * leave the door open to "fixing" the asymmetry in the other direction and
 * breaking macOS and Linux instead.
 *
 * These read the registry objects directly rather than going through
 * pickPlatformValue, so the assertions hold on every CI platform rather than
 * only on the host that happens to be running them.
 */

type PathMap = NonNullable<BundledDependency["archive"]>["binaryPathInArchive"];

const uvDeps: { mcpId: string; dep: BundledDependency }[] = BUNDLED_MCP_SERVERS.flatMap(
  (mcp) =>
    (mcp.dependencies ?? [])
      .filter((d) => d.binary === "uv")
      .map((dep) => ({ mcpId: mcp.id, dep })),
);

describe("uv binaryPathInArchive matches how astral-sh actually packages uv", () => {
  it("the registry still hosts uv deps to guard", () => {
    // A rename or removal must fail loudly here rather than turning every
    // assertion below into a vacuous pass over an empty list.
    expect(uvDeps.length).toBeGreaterThan(0);
  });

  for (const { mcpId, dep } of uvDeps) {
    describe(mcpId, () => {
      const paths = dep.archive?.binaryPathInArchive as PathMap;

      it("win32 is the bare executable at the zip root", () => {
        expect(paths).toBeDefined();
        expect((paths as Record<string, unknown>).win32).toBe("uv.exe");
      });

      it("win32 carries no directory component at all", () => {
        const win32 = (paths as Record<string, string>).win32;
        expect(win32).not.toContain("/");
        expect(win32).not.toContain("\\");
      });

      it("linux and darwin keep their target-triple directory prefix", () => {
        const p = paths as Record<string, unknown>;
        expect(p.linux).toBe("uv-x86_64-unknown-linux-gnu/uv");
        expect(p.darwin).toEqual({
          arm64: "uv-aarch64-apple-darwin/uv",
          x64: "uv-x86_64-apple-darwin/uv",
        });
      });
    });
  }
});
