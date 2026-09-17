import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildSafeServerEnv,
  requiredEnvVarsForServer,
} from "@/lib/mcp/safe-env";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

afterEach(() => vi.unstubAllEnvs());

describe("requiredEnvVarsForServer", () => {
  it("returns [] for every libi row — libi holds no provider key", () => {
    for (const def of BUNDLED_MCP_SERVERS) {
      expect(requiredEnvVarsForServer(def.name), def.id).toEqual([]);
    }
  });

  it("returns [] for an unknown / foreign server name", () => {
    expect(requiredEnvVarsForServer("Some Custom MCP")).toEqual([]);
    expect(requiredEnvVarsForServer("ElevenLabs")).toEqual([]);
  });
});

describe("buildSafeServerEnv", () => {
  it("drops every inherited secret and keeps only operational vars", () => {
    // These secrets are all present in the process env (a user exported
    // them for their own MCPs), so the filter must recognize them as
    // inherited and drop them — no libi row is entitled to any of them.
    vi.stubEnv("ELEVENLABS_API_KEY", "sk-elevenlabs");
    vi.stubEnv("FAL_KEY", "sk-fal");
    vi.stubEnv("git_token", "ghp_xxx");

    const env = buildSafeServerEnv(
      "Libi Tracking",
      {
        ELEVENLABS_API_KEY: "sk-elevenlabs", // inherited secret — DROPPED
        FAL_KEY: "sk-fal", // inherited secret — DROPPED
        git_token: "ghp_xxx", // inherited secret — DROPPED
        PATH: "/libi/bin:/usr/bin", // operational — KEPT
        HOME: "/Users/me", // operational — KEPT
      },
      { libiHome: "/home/x" },
    );

    expect(env).toEqual({
      PATH: "/libi/bin:/usr/bin",
      HOME: "/Users/me",
      LIBI_HOME: "/home/x",
    });
  });

  it("keeps a var the entry declares that isn't an inherited process-env key", () => {
    // A foreign MCP's configured secret lives on the entry, not process.env.
    const env = buildSafeServerEnv(
      "Some Custom MCP",
      { MY_CUSTOM_TOKEN: "abc", PATH: "/p" },
      { libiHome: "/h" },
    );
    expect(env.MY_CUSTOM_TOKEN).toBe("abc");
    expect(env.PATH).toBe("/p");
    expect(env.LIBI_HOME).toBe("/h");
  });

  it("always pins LIBI_HOME even when the entry has no env", () => {
    const env = buildSafeServerEnv("libi", undefined, { libiHome: "/wt/home" });
    expect(env).toEqual({ LIBI_HOME: "/wt/home" });
  });
});
