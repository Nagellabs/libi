import { describe, it, expect } from "vitest";
import {
  parseConfiguredEnvVarNames,
  parseConfiguredHeaderNames,
  parseEnvVarsMap,
  mergeEnvVars,
  mergeHeaders,
  redactServerRow,
} from "@/lib/security/redact-mcp-server";

describe("parseConfiguredEnvVarNames", () => {
  it("returns the KEYS of a populated envVars JSON", () => {
    expect(parseConfiguredEnvVarNames('{"FAL_KEY":"secret"}')).toEqual(["FAL_KEY"]);
  });
  it("omits blank / null / undefined values", () => {
    expect(
      parseConfiguredEnvVarNames('{"A":"x","B":"","C":null}'),
    ).toEqual(["A"]);
  });
  it("returns [] for null / malformed", () => {
    expect(parseConfiguredEnvVarNames(null)).toEqual([]);
    expect(parseConfiguredEnvVarNames("not json")).toEqual([]);
  });
});

describe("redactServerRow", () => {
  it("strips envVars and adds configuredEnvVars (key NAMES only)", () => {
    const row = {
      id: "fal-ai",
      name: "fal.ai",
      envVars: '{"FAL_KEY":"secret"}',
      installStatus: "installed",
    };
    const out = redactServerRow(row);
    expect(out.configuredEnvVars).toEqual(["FAL_KEY"]);
    // The serialized output must contain NEITHER the envVars value nor the secret.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("secret");
    expect(out).not.toHaveProperty("envVars");
    // Other fields survive.
    expect(out.id).toBe("fal-ai");
    expect(out.installStatus).toBe("installed");
  });
  it("handles a row with null envVars", () => {
    const out = redactServerRow({ id: "x", envVars: null });
    expect(out.configuredEnvVars).toEqual([]);
    expect(out).not.toHaveProperty("envVars");
  });
  it("strips headers and adds configuredHeaders (header NAMES only), never the value", () => {
    const row = {
      id: "fal-ai",
      name: "fal.ai",
      type: "http",
      headers: '{"Authorization":"Bearer secret123"}',
      installStatus: "installed",
    };
    const out = redactServerRow(row);
    expect(out.configuredHeaders).toEqual(["Authorization"]);
    // The serialized output must contain the header NAME but NEITHER the raw
    // headers value NOR the bearer secret.
    const serialized = JSON.stringify(out);
    expect(serialized).toContain('configuredHeaders":["Authorization"]');
    expect(serialized).not.toContain("secret123");
    expect(serialized).not.toContain("Bearer secret123");
    expect(out).not.toHaveProperty("headers");
    // Other fields survive.
    expect(out.id).toBe("fal-ai");
    expect(out.installStatus).toBe("installed");
  });
  it("handles a row with null / absent headers", () => {
    expect(redactServerRow({ id: "x", headers: null }).configuredHeaders).toEqual([]);
    // A row with no headers property at all (stdio server) → [].
    const stdioRow = { id: "y", envVars: null } as { id: string; envVars: string | null };
    expect(redactServerRow(stdioRow).configuredHeaders).toEqual([]);
  });
});

describe("parseConfiguredHeaderNames", () => {
  it("returns the header KEYS of a populated headers JSON", () => {
    expect(parseConfiguredHeaderNames('{"Authorization":"Bearer secret123"}')).toEqual([
      "Authorization",
    ]);
  });
  it("omits blank values and returns [] for null / malformed", () => {
    expect(parseConfiguredHeaderNames('{"A":"x","B":""}')).toEqual(["A"]);
    expect(parseConfiguredHeaderNames(null)).toEqual([]);
    expect(parseConfiguredHeaderNames("not json")).toEqual([]);
  });
});

describe("mergeHeaders", () => {
  it("merges incoming headers, leaving blanks unchanged (do not wipe stored bearer secret)", () => {
    const merged = mergeHeaders('{"Authorization":"Bearer kept","X-Old":"a"}', {
      "X-Old": "b",
      "X-Blank": "",
      "X-Added": "c",
    });
    expect(merged).toEqual({ Authorization: "Bearer kept", "X-Old": "b", "X-Added": "c" });
  });
  it("a fully-blank incoming map preserves the existing Authorization secret", () => {
    const merged = mergeHeaders('{"Authorization":"Bearer secret123"}', { Authorization: "" });
    expect(merged).toEqual({ Authorization: "Bearer secret123" });
  });
});

describe("parseEnvVarsMap + mergeEnvVars", () => {
  it("parses the full value map (server-side only)", () => {
    expect(parseEnvVarsMap('{"FAL_KEY":"secret"}')).toEqual({ FAL_KEY: "secret" });
    expect(parseEnvVarsMap(null)).toEqual({});
  });
  it("merges incoming keys, leaving blanks unchanged (do not wipe stored secret)", () => {
    const merged = mergeEnvVars('{"FAL_KEY":"kept","OTHER":"old"}', {
      OTHER: "new",
      BLANK: "",
      ADDED: "added",
    });
    expect(merged).toEqual({ FAL_KEY: "kept", OTHER: "new", ADDED: "added" });
  });
  it("a fully-blank incoming map preserves the existing secret", () => {
    const merged = mergeEnvVars('{"FAL_KEY":"secret"}', { FAL_KEY: "" });
    expect(merged).toEqual({ FAL_KEY: "secret" });
  });
});
