import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema";
import { seedDatabase } from "@/lib/db/init";

describe("seedDatabase fal-ai HTTP row", () => {
  beforeEach(() => createTestDb());
  afterEach(() => resetTestDb());

  it("inserts fal-ai with url + headers + requiredEnvVars", () => {
    seedDatabase(getDb() as never);
    const row = getDb().select().from(mcpServers).where(eq(mcpServers.id, "fal-ai")).get();
    expect(row).toBeDefined();
    expect(row!.type).toBe("http");
    expect(row!.url).toBe("https://mcp.fal.ai/mcp");
    expect(JSON.parse(row!.headers ?? "{}")).toEqual({ Authorization: "Bearer ${FAL_KEY}" });
  });

  it("starts in needs_config until FAL_KEY is provided", () => {
    seedDatabase(getDb() as never);
    const row = getDb().select().from(mcpServers).where(eq(mcpServers.id, "fal-ai")).get();
    expect(row!.installStatus).toBe("needs_config");
  });

  it("upgrades to installed once envVars contains FAL_KEY (after re-seed)", () => {
    seedDatabase(getDb() as never);
    // Simulate user providing FAL_KEY via the Configure dialog
    getDb()
      .update(mcpServers)
      .set({ envVars: JSON.stringify({ FAL_KEY: "secret" }), installStatus: "installed" })
      .where(eq(mcpServers.id, "fal-ai"))
      .run();
    seedDatabase(getDb() as never);
    const row = getDb().select().from(mcpServers).where(eq(mcpServers.id, "fal-ai")).get();
    // Re-seed must NOT downgrade back to needs_config because user provided the key
    expect(row!.installStatus).toBe("installed");
    expect(JSON.parse(row!.envVars ?? "{}")).toEqual({ FAL_KEY: "secret" });
  });

  it("preserves user's enabled choice on re-seed", () => {
    seedDatabase(getDb() as never);
    getDb().update(mcpServers).set({ enabled: false }).where(eq(mcpServers.id, "fal-ai")).run();
    seedDatabase(getDb() as never);
    const row = getDb().select().from(mcpServers).where(eq(mcpServers.id, "fal-ai")).get();
    expect(row!.enabled).toBe(false);
  });
});
