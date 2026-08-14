// __tests__/integration/mcp-needs-config.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { mcpServers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/libi-home", async () => {
  const actual = await vi.importActual<typeof import("@/lib/libi-home")>(
    "@/lib/libi-home",
  );
  return {
    ...actual,
    getLibiBinDir: () => "/tmp/libi-test-bin",
  };
});

import { getDb } from "@/lib/db/client";
import { getMcpServersForSettings, invalidateMcpConfig } from "@/lib/mcp-config";
import { DependencyManager } from "@/mcp/registry/dependency-manager";

beforeEach(() => {
  const db = createTestDb();
  vi.mocked(getDb).mockReturnValue(db as never);
  invalidateMcpConfig();
});

afterEach(() => {
  resetTestDb();
  invalidateMcpConfig();
});

describe("needs_config end-to-end", () => {
  it("a needs_config bundled row is excluded from getMcpServersForSettings()", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    db.insert(mcpServers).values({
      id: "elevenlabs",
      name: "ElevenLabs",
      description: "x",
      npmUrl: null,
      type: "stdio",
      command: "uvx",
      args: JSON.stringify(["elevenlabs-mcp"]),
      enabled: true,
      requireApproval: true,
      bundled: true,
      installStatus: "needs_config",
      envVars: null,
    }).run();
    invalidateMcpConfig();

    const servers = getMcpServersForSettings();
    expect(servers).not.toHaveProperty("ElevenLabs");
    // libi (core) is always there
    expect(servers).toHaveProperty("libi");
  });

  it("evaluateConfigStatus + DB update flips needs_config → installed", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    db.insert(mcpServers).values({
      id: "elevenlabs",
      name: "ElevenLabs",
      description: "x",
      npmUrl: null,
      type: "stdio",
      command: "uvx",
      args: JSON.stringify(["elevenlabs-mcp"]),
      enabled: true,
      requireApproval: true,
      bundled: true,
      installStatus: "needs_config",
      envVars: null,
    }).run();

    // Set the key
    const updated = JSON.stringify({ ELEVENLABS_API_KEY: "sk_test" });
    db.update(mcpServers)
      .set({ envVars: updated })
      .where(eq(mcpServers.id, "elevenlabs"))
      .run();

    // Re-evaluate
    const [row] = db.select().from(mcpServers).where(eq(mcpServers.id, "elevenlabs")).limit(1).all();
    const config = DependencyManager.evaluateConfigStatus({
      requiredEnvVars: ["ELEVENLABS_API_KEY"],
      envVarsJson: row.envVars,
    });
    expect(config.status).toBe("installed");

    db.update(mcpServers)
      .set({ installStatus: config.status, installError: null })
      .where(eq(mcpServers.id, "elevenlabs"))
      .run();
    invalidateMcpConfig();

    const servers = getMcpServersForSettings();
    expect(servers).toHaveProperty("ElevenLabs");
    expect(servers.ElevenLabs.command).toBe("uvx");
    expect(servers.ElevenLabs.env?.ELEVENLABS_API_KEY).toBe("sk_test");
  });
});
