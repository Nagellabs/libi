import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema";
import { invalidateMcpConfig, getMcpServersForSettings } from "@/lib/mcp-config";

beforeEach(() => {
  createTestDb();
  // Seed both fal-ai and fake-ai-assets rows so we can test filtering.
  getDb()
    .insert(mcpServers)
    .values([
      {
        id: "fal-ai",
        name: "fal-ai",
        description: "real fal",
        type: "http",
        command: "",
        args: "[]",
        url: "https://mcp.fal.ai/mcp",
        headers: JSON.stringify({ Authorization: "Bearer ${FAL_KEY}" }),
        envVars: JSON.stringify({ FAL_KEY: "test-key" }),
        bundled: true,
        enabled: true,
        requireApproval: true,
        installStatus: "installed",
        dependencyStatus: "[]",
      },
      {
        id: "fake-ai-assets",
        name: "fake-ai-assets",
        description: "placeholder",
        type: "stdio",
        command: "node",
        args: JSON.stringify(["--import", "tsx", "mcp/dev/fake-ai-assets/index.ts"]),
        url: null,
        headers: null,
        bundled: true,
        enabled: true,
        requireApproval: false,
        installStatus: "installed",
        envVars: "{}",
        dependencyStatus: "[]",
      },
    ])
    .run();
  invalidateMcpConfig();
});

afterEach(() => {
  resetTestDb();
  invalidateMcpConfig();
  vi.unstubAllEnvs();
});

describe("buildMcpServers test-mode behavior", () => {
  it("includes fal-ai when LIBI_TEST_MODE is unset", () => {
    vi.stubEnv("LIBI_TEST_MODE", "");
    invalidateMcpConfig();
    const servers = getMcpServersForSettings();
    expect(servers["fal-ai"]).toBeDefined();
    // fake-ai-assets row also exists in the DB; outside test mode the filter
    // does not remove it (the bundled-list seeding gates it instead). Either
    // outcome here is acceptable — the load-bearing assertion is fal-ai is
    // present.
  });

  it("swaps fal-ai to fake-fal stdio server when LIBI_TEST_MODE=1", () => {
    vi.stubEnv("LIBI_TEST_MODE", "1");
    invalidateMcpConfig();
    const servers = getMcpServersForSettings();
    // fal-ai is now masqueraded as the fake-fal stdio server (not hidden).
    // The agent's tool ids remain mcp__fal-ai__* — same server name, different spawn.
    expect(servers["fal-ai"]).toBeDefined();
    const falEntry = servers["fal-ai"] as { command: string; args?: string[] };
    expect("command" in falEntry).toBe(true);
    expect(falEntry.args?.some((a) => a.includes("fake-fal"))).toBe(true);
    expect(servers["fake-ai-assets"]).toBeDefined();
  });
});
