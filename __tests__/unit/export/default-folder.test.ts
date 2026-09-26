/**
 * The default export folder. In test mode (skill-eval, `LIBI_TEST_MODE=1`) it
 * lives inside LIBI_HOME, so a hermetic run never writes into the user's real
 * Movies/Videos folder (the 2026-09-24 eval runs left three example videos in
 * ~/Movies/libi). Otherwise it is the OS's video folder. Every case pins the
 * platform: CI is ubuntu-only.
 */
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultExportFolder } from "@/lib/export/folder";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
function onPlatform<T>(p: NodeJS.Platform, fn: () => T): T {
  Object.defineProperty(process, "platform", { value: p });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
}

afterEach(() => vi.unstubAllEnvs());

describe("defaultExportFolder", () => {
  it("in test mode stays inside LIBI_HOME, on every platform", () => {
    vi.stubEnv("LIBI_TEST_MODE", "1");
    vi.stubEnv("LIBI_HOME", "/tmp/eval-home");
    for (const p of ["darwin", "win32", "linux"] as const) {
      expect(onPlatform(p, () => defaultExportFolder())).toBe(path.join("/tmp/eval-home", "exports"));
    }
  });

  it("LIBI_TEST_MODE=true counts as test mode too", () => {
    vi.stubEnv("LIBI_TEST_MODE", "true");
    vi.stubEnv("LIBI_HOME", "/tmp/eval-home");
    expect(onPlatform("darwin", () => defaultExportFolder())).toBe(path.join("/tmp/eval-home", "exports"));
  });

  it("otherwise keeps the OS folder (darwin: Movies)", () => {
    vi.stubEnv("LIBI_TEST_MODE", "");
    vi.stubEnv("LIBI_HOME", "/tmp/eval-home");
    expect(onPlatform("darwin", () => defaultExportFolder())).toBe(path.join(os.homedir(), "Movies", "libi"));
  });

  it("otherwise keeps the OS folder (win32 / linux: Videos)", () => {
    vi.stubEnv("LIBI_TEST_MODE", "0");
    expect(onPlatform("win32", () => defaultExportFolder())).toBe(path.join(os.homedir(), "Videos", "libi"));
    expect(onPlatform("linux", () => defaultExportFolder())).toBe(path.join(os.homedir(), "Videos", "libi"));
  });
});
