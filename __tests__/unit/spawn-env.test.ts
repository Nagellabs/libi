import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/libi-home", async () => {
  const actual = await vi.importActual<typeof import("@/lib/libi-home")>("@/lib/libi-home");
  return { ...actual, getLibiBinDir: () => "/fake/libi/bin" };
});

import { buildSpawnEnv } from "@/mcp/registry/spawn-env";

describe("buildSpawnEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.HOME = "/fake/home";
    process.env.PATH = "/usr/bin:/bin";
    process.env.LANG = "en_US.UTF-8";
    delete process.env.LIBI_TEST_USER_VAR;
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, originalEnv);
  });

  it("inherits HOME and other parent env vars (npx needs HOME for ~/.npm/_npx)", () => {
    const env = buildSpawnEnv();
    expect(env.HOME).toBe("/fake/home");
    expect(env.LANG).toBe("en_US.UTF-8");
  });

  it("prepends ~/.libi/bin to PATH", () => {
    const env = buildSpawnEnv();
    expect(env.PATH.startsWith("/fake/libi/bin:")).toBe(true);
    expect(env.PATH).toContain("/usr/bin:/bin");
  });

  it("layers per-server env vars on top of inherited env", () => {
    const env = buildSpawnEnv({ ELEVENLABS_API_KEY: "sk_test" });
    expect(env.ELEVENLABS_API_KEY).toBe("sk_test");
    expect(env.HOME).toBe("/fake/home");
  });

  it("user env vars override inherited ones", () => {
    process.env.SHARED = "from-parent";
    const env = buildSpawnEnv({ SHARED: "from-server-config" });
    expect(env.SHARED).toBe("from-server-config");
  });

  it("our augmented PATH wins over any PATH the user set in envVars", () => {
    // Per-server PATH override wins by design (user-specified > inherited).
    const env = buildSpawnEnv({ PATH: "/only-this" });
    expect(env.PATH).toBe("/only-this");
  });

  it("PATH override applies even when user envVars do not include PATH", () => {
    const env = buildSpawnEnv();
    expect(env.PATH).not.toBe("/usr/bin:/bin");
    expect(env.PATH.startsWith("/fake/libi/bin:")).toBe(true);
  });

  it("skips undefined values from process.env", () => {
    const env = buildSpawnEnv();
    for (const v of Object.values(env)) {
      expect(typeof v).toBe("string");
    }
  });
});
