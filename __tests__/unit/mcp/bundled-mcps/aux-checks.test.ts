import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { checkBinary, checkEnvVar } from "@/mcp/bundled-mcps/aux-checks";

describe("checkBinary", () => {
  it("returns ok=true with path + version when binary exists and runs fast", async () => {
    const result = await checkBinary("echo");
    expect(result.name).toBe("echo");
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/^\/|^\w/); // a path
  });

  it("returns ok=false when binary not found", async () => {
    const result = await checkBinary("definitely-not-a-real-binary-9876");
    expect(result.ok).toBe(false);
    expect(result.detail.toLowerCase()).toContain("not found");
  });
});

describe("checkEnvVar", () => {
  it("returns ok=true when the env var is set in row.envVars", () => {
    const row = { envVars: JSON.stringify({ FAL_KEY: "sk_abc" }) };
    const result = checkEnvVar(row, "FAL_KEY");
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("set");
  });

  it("returns ok=false when the env var is missing", () => {
    const row = { envVars: "{}" };
    const result = checkEnvVar(row, "FAL_KEY");
    expect(result.ok).toBe(false);
    expect(result.detail.toLowerCase()).toContain("missing");
  });

  it("returns ok=false when row.envVars is null/undefined", () => {
    const row = { envVars: null };
    const result = checkEnvVar(row, "FAL_KEY");
    expect(result.ok).toBe(false);
  });

  it("never leaks the env value in the detail field", () => {
    const row = { envVars: JSON.stringify({ FAL_KEY: "sk_supersecret_dont_log" }) };
    const result = checkEnvVar(row, "FAL_KEY");
    expect(result.detail).not.toContain("sk_supersecret");
  });
});
