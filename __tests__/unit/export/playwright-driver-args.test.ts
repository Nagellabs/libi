import { describe, it, expect } from "vitest";
import {
  buildLaunchArgs,
  isSoftwareRenderer,
  resolveAngleBackend,
} from "@/lib/export/drivers/playwright";

const NO_ENV = {};
const withBackend = (v: string) => ({ LIBI_RENDER_ANGLE_BACKEND: v });

describe("resolveAngleBackend", () => {
  it("maps each platform to its native ANGLE backend", () => {
    expect(resolveAngleBackend("darwin", NO_ENV)).toBe("metal");
    expect(resolveAngleBackend("win32", NO_ENV)).toBe("d3d11");
    expect(resolveAngleBackend("linux", NO_ENV)).toBe("gl");
  });

  it("falls back to gl for unknown platforms", () => {
    expect(resolveAngleBackend("freebsd", NO_ENV)).toBe("gl");
    expect(resolveAngleBackend("openbsd", NO_ENV)).toBe("gl");
  });

  it("LIBI_RENDER_ANGLE_BACKEND overrides the platform default (both directions)", () => {
    expect(resolveAngleBackend("linux", withBackend("vulkan"))).toBe("vulkan");
    expect(resolveAngleBackend("win32", withBackend("d3d9"))).toBe("d3d9");
    // Override wins even on darwin.
    expect(resolveAngleBackend("darwin", withBackend("gl"))).toBe("gl");
  });

  it("ignores a blank/whitespace override", () => {
    expect(resolveAngleBackend("linux", withBackend("   "))).toBe("gl");
  });
});

describe("buildLaunchArgs", () => {
  it("software mode returns exactly the legacy flag set (platform-independent)", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      expect(buildLaunchArgs("software", platform, NO_ENV)).toEqual([
        "--enable-features=OpenH264SoftwareEncoder",
        "--use-gl=swiftshader",
      ]);
    }
  });

  it("gpu mode never contains --use-gl=swiftshader on any platform", () => {
    for (const platform of ["darwin", "win32", "linux", "freebsd"]) {
      const args = buildLaunchArgs("gpu", platform, NO_ENV);
      expect(args.some((a) => a.includes("swiftshader"))).toBe(false);
    }
  });

  it("gpu mode selects the per-platform ANGLE backend", () => {
    expect(buildLaunchArgs("gpu", "darwin", NO_ENV)).toContain("--use-angle=metal");
    expect(buildLaunchArgs("gpu", "win32", NO_ENV)).toContain("--use-angle=d3d11");
    expect(buildLaunchArgs("gpu", "linux", NO_ENV)).toContain("--use-angle=gl");
  });

  it("gpu mode always carries the shared GPU-enable flags", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      const args = buildLaunchArgs("gpu", platform, NO_ENV);
      expect(args).toContain("--enable-gpu");
      expect(args).toContain("--ignore-gpu-blocklist");
      // Keeps the software H.264 encoder feature as a transparent encode fallback.
      expect(args).toContain("--enable-features=OpenH264SoftwareEncoder");
    }
  });

  it("gpu mode honors the ANGLE backend override", () => {
    const args = buildLaunchArgs("gpu", "linux", withBackend("vulkan"));
    expect(args).toContain("--use-angle=vulkan");
    expect(args).not.toContain("--use-angle=gl");
  });
});

describe("isSoftwareRenderer", () => {
  it("classifies software rasterizers as software", () => {
    expect(isSoftwareRenderer("Google SwiftShader")).toBe(true);
    expect(isSoftwareRenderer("llvmpipe (LLVM 15.0.7)")).toBe(true);
    expect(isSoftwareRenderer("SwiftShader Device (Subzero)")).toBe(true);
    expect(isSoftwareRenderer("Software Rasterizer")).toBe(true);
  });

  it("classifies a real GPU renderer as hardware", () => {
    expect(
      isSoftwareRenderer("ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)"),
    ).toBe(false);
    expect(
      isSoftwareRenderer("ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0)"),
    ).toBe(false);
  });
});
