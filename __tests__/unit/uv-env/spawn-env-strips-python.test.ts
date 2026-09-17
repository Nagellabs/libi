import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildUvEnv } from "@/lib/uv-env/spawn-env";

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

/** A Python environment imported from the user's profile must never reach uv —
 *  it would relocate or poison every libi Python runner. */
describe("buildUvEnv strips the user's Python environment", () => {
  let snapshot: NodeJS.ProcessEnv;
  beforeEach(() => {
    snapshot = { ...process.env };
    process.env.LIBI_HOME = "/tmp/libi-uv-env-test";
    process.env.PYTHONHOME = "/opt/py";
    process.env.PYTHONPATH = "/opt/py/lib";
    process.env.VIRTUAL_ENV = "/opt/venv";
    process.env.CONDA_PREFIX = "/opt/conda";
    process.env.CONDA_DEFAULT_ENV = "base";
    process.env.KEEP_ME = "yes";
  });
  afterEach(() => {
    process.env = snapshot;
  });

  it("drops PYTHONHOME, PYTHONPATH, VIRTUAL_ENV and every CONDA_* on every surface", () => {
    const env = buildUvEnv();
    for (const k of ["PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "CONDA_PREFIX", "CONDA_DEFAULT_ENV"]) {
      expect(env[k], k).toBeUndefined();
    }
    expect(env.KEEP_ME).toBe("yes");
    expect(env.UV_CACHE_DIR).toContain("/tmp/libi-uv-env-test");
  });

  it("matches names case-insensitively, as Windows environment names are", () => {
    // On a posix host process.env is case-sensitive, so these are distinct keys that
    // stand in for the mixed-case names a Windows environment block can carry.
    process.env.pythonpath = "/opt/py/lib";
    process.env.PythonHome = "/opt/py";
    process.env.virtual_env = "/opt/venv";
    process.env.conda_prefix = "/opt/conda";
    const env = withPlatform("win32", () => buildUvEnv());
    for (const k of ["pythonpath", "PythonHome", "virtual_env", "conda_prefix"]) {
      expect(env[k], k).toBeUndefined();
    }
    expect(env.KEEP_ME).toBe("yes");
  });

  it("still lets `extra` set a Python variable deliberately", () => {
    const env = buildUvEnv({ PYTHONPATH: "/libi/own" });
    expect(env.PYTHONPATH).toBe("/libi/own");
  });
});
