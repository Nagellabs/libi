import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildSafeServerEnv,
  requiredEnvVarsForServer,
} from "@/lib/mcp/safe-env";

afterEach(() => vi.unstubAllEnvs());

describe("requiredEnvVarsForServer", () => {
  it("returns a bundled MCP's declared required env vars", () => {
    expect(requiredEnvVarsForServer("ElevenLabs")).toEqual(["ELEVENLABS_API_KEY"]);
    expect(requiredEnvVarsForServer("fal-ai")).toEqual(["FAL_KEY"]);
  });

  it("returns [] for MCPs that need no secret", () => {
    expect(requiredEnvVarsForServer("YouTube Downloader")).toEqual([]);
  });

  it("returns [] for an unknown / custom server name", () => {
    expect(requiredEnvVarsForServer("Some Custom MCP")).toEqual([]);
  });
});

describe("buildSafeServerEnv", () => {
  it("keeps a server's OWN required key but drops OTHER inherited secrets", () => {
    // These secrets are all present in the process env (libi injects them
    // there), so the filter must recognize them as inherited.
    vi.stubEnv("ELEVENLABS_API_KEY", "sk-elevenlabs");
    vi.stubEnv("FAL_KEY", "sk-fal");
    vi.stubEnv("git_token", "ghp_xxx");

    const env = buildSafeServerEnv(
      "ElevenLabs",
      {
        ELEVENLABS_API_KEY: "sk-elevenlabs", // its own required key — KEPT
        FAL_KEY: "sk-fal", // another service's secret — DROPPED
        git_token: "ghp_xxx", // unrelated inherited secret — DROPPED
        PATH: "/libi/bin:/usr/bin", // operational — KEPT
        HOME: "/Users/me", // operational — KEPT
      },
      { libiHome: "/home/x" },
    );

    expect(env).toEqual({
      ELEVENLABS_API_KEY: "sk-elevenlabs",
      PATH: "/libi/bin:/usr/bin",
      HOME: "/Users/me",
      LIBI_HOME: "/home/x",
    });
    expect(env).not.toHaveProperty("FAL_KEY");
    expect(env).not.toHaveProperty("git_token");
  });

  it("drops a secret from a server that does NOT require it", () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "sk-elevenlabs");
    const env = buildSafeServerEnv(
      "YouTube Downloader", // requiredEnvVars: []
      { ELEVENLABS_API_KEY: "sk-elevenlabs", PATH: "/p" },
      { libiHome: "/h" },
    );
    expect(env).toEqual({ PATH: "/p", LIBI_HOME: "/h" });
    expect(env).not.toHaveProperty("ELEVENLABS_API_KEY");
  });

  it("keeps a var the entry declares that isn't an inherited process-env key", () => {
    // A custom MCP's DB-configured secret lives on the entry, not process.env.
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
