import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { mcpServers } from "@/lib/db/schema";
import { DependencyManager } from "@/mcp/registry/dependency-manager";

beforeEach(() => createTestDb());
afterEach(() => resetTestDb());

describe("DependencyManager.evaluateConfigStatus", () => {
  it("returns 'installed' when no requiredEnvVars are declared", () => {
    const status = DependencyManager.evaluateConfigStatus({
      requiredEnvVars: undefined,
      envVarsJson: null,
    });
    expect(status).toEqual({ status: "installed", missing: [] });
  });

  it("returns 'installed' when requiredEnvVars are all present and non-empty", () => {
    const status = DependencyManager.evaluateConfigStatus({
      requiredEnvVars: ["KEY"],
      envVarsJson: JSON.stringify({ KEY: "secret" }),
    });
    expect(status).toEqual({ status: "installed", missing: [] });
  });

  it("returns 'needs_config' when envVarsJson is null", () => {
    const status = DependencyManager.evaluateConfigStatus({
      requiredEnvVars: ["KEY"],
      envVarsJson: null,
    });
    expect(status).toEqual({ status: "needs_config", missing: ["KEY"] });
  });

  it("returns 'needs_config' when a required key is empty string", () => {
    const status = DependencyManager.evaluateConfigStatus({
      requiredEnvVars: ["KEY"],
      envVarsJson: JSON.stringify({ KEY: "" }),
    });
    expect(status).toEqual({ status: "needs_config", missing: ["KEY"] });
  });

  it("lists multiple missing keys", () => {
    const status = DependencyManager.evaluateConfigStatus({
      requiredEnvVars: ["A", "B", "C"],
      envVarsJson: JSON.stringify({ A: "x" }),
    });
    expect(status.status).toBe("needs_config");
    expect(status.missing.sort()).toEqual(["B", "C"]);
  });

  it("survives malformed envVarsJson by treating it as empty", () => {
    const status = DependencyManager.evaluateConfigStatus({
      requiredEnvVars: ["KEY"],
      envVarsJson: "not json",
    });
    expect(status).toEqual({ status: "needs_config", missing: ["KEY"] });
  });
});

void mcpServers;
