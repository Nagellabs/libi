/**
 * Every uv libi runs uses ONLY a uv-managed CPython (lib/uv-env/spawn-env.ts
 * UV_PYTHON_PREFERENCE). uv's default still discovers system interpreters by
 * EXECUTING the first `python3` on PATH — on a Mac without the Command Line
 * Tools that is the /usr/bin/python3 stub (dialog + exit 1), which uv treats
 * as fatal before it would download a managed one. A broken pyenv shim fails
 * the same way. `only-managed` never looks at PATH.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { buildUvEnv, UV_PYTHON_DOWNLOADS, UV_PYTHON_PREFERENCE } from "@/lib/uv-env/spawn-env";

const HOME = "/tmp/libi-uv-pref-test";
/** Where the managed interpreters live, joined the way the host's `path` joins it (`\` on Windows). */
const MANAGED_PYTHON_DIR = path.join(HOME, "uv", "python");

describe("buildUvEnv pins uv to managed Python", () => {
  let snapshot: NodeJS.ProcessEnv;
  beforeEach(() => {
    snapshot = { ...process.env };
    process.env.LIBI_HOME = HOME;
  });
  afterEach(() => {
    process.env = snapshot;
  });

  it("sets UV_PYTHON_PREFERENCE=only-managed by default", () => {
    expect(UV_PYTHON_PREFERENCE).toBe("only-managed");
    expect(buildUvEnv().UV_PYTHON_PREFERENCE).toBe("only-managed");
  });

  it("overrides a user's inherited preference (a profile's `system` must not reach uv)", () => {
    process.env.UV_PYTHON_PREFERENCE = "only-system";
    expect(buildUvEnv().UV_PYTHON_PREFERENCE).toBe("only-managed");
  });

  it("lets uv DOWNLOAD that managed Python, overriding a user's UV_PYTHON_DOWNLOADS=never|manual", () => {
    // only-managed with downloads off leaves uv no interpreter at all. The env
    // var outranks a `python-downloads = "never"` in the user's uv.toml
    // (verified with uv 0.11.32), so UV_NO_CONFIG is deliberately NOT set.
    expect(UV_PYTHON_DOWNLOADS).toBe("automatic");
    for (const inherited of ["never", "manual"]) {
      process.env.UV_PYTHON_DOWNLOADS = inherited;
      expect(buildUvEnv().UV_PYTHON_DOWNLOADS, inherited).toBe("automatic");
    }
    expect(buildUvEnv().UV_NO_CONFIG).toBeUndefined();
  });

  it("drops an inherited UV_PYTHON / UV_NO_MANAGED_PYTHON / UV_MANAGED_PYTHON (the desktop app imports the login shell)", () => {
    // Reproduced with uv 0.11.32: UV_NO_MANAGED_PYTHON=1 fails EVERY uv call
    // ("cannot be used with --python-preference"), and UV_PYTHON=<broken shim>
    // makes every call without its own --python (uv sync, uv run --frozen,
    // the tracking selftest, the YOLOE export) inspect that shim and fail
    // "Failed to inspect Python interpreter" despite only-managed.
    process.env.UV_PYTHON = "/Users/me/.pyenv/shims/python3";
    process.env.UV_NO_MANAGED_PYTHON = "1";
    process.env.UV_MANAGED_PYTHON = "1";
    process.env.uv_python = "3.11"; // Windows names are case-insensitive
    const env = buildUvEnv();
    for (const k of ["UV_PYTHON", "UV_NO_MANAGED_PYTHON", "UV_MANAGED_PYTHON", "uv_python"]) {
      expect(env[k], k).toBeUndefined();
    }
    // Not over-matched: libi's own UV_PYTHON_* settings survive.
    expect(env.UV_PYTHON_PREFERENCE).toBe("only-managed");
    expect(env.UV_PYTHON_DOWNLOADS).toBe("automatic");
    expect(env.UV_PYTHON_INSTALL_DIR).toBe(MANAGED_PYTHON_DIR);
  });

  it("still lets `extra` pin UV_PYTHON deliberately", () => {
    expect(buildUvEnv({ UV_PYTHON: "3.12" }).UV_PYTHON).toBe("3.12");
  });

  it("is layered under `extra`, which a caller can still use deliberately", () => {
    expect(buildUvEnv({ UV_PYTHON_PREFERENCE: "managed" }).UV_PYTHON_PREFERENCE).toBe("managed");
  });

  it("keeps the managed interpreters themselves under LIBI_HOME", () => {
    expect(buildUvEnv().UV_PYTHON_INSTALL_DIR).toBe(MANAGED_PYTHON_DIR);
  });
});
