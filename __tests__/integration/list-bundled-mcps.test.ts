// __tests__/integration/list-bundled-mcps.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { mcpServers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

vi.mock("@/mcp/notify", () => ({
  notify: { navigateSettings: vi.fn() },
}));

vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "@/lib/db/client";
import { listBundledMcps } from "@/mcp/tools/mcp-status-tools";

let dbHandle: ReturnType<typeof createTestDb>;

beforeEach(() => {
  dbHandle = createTestDb();
  vi.mocked(getDb).mockReturnValue(dbHandle as never);
  dbHandle.insert(mcpServers).values([
    {
      id: "elevenlabs",
      name: "ElevenLabs",
      description: "stt",
      npmUrl: null,
      type: "stdio",
      command: "uvx",
      args: JSON.stringify(["elevenlabs-mcp"]),
      enabled: true,
      requireApproval: true,
      bundled: true,
      installStatus: "needs_config",
      envVars: null,
    },
    {
      id: "youtube-downloader",
      name: "YouTube Downloader",
      description: "yt-dlp",
      npmUrl: "https://www.npmjs.com/package/@kevinwatt/yt-dlp-mcp",
      type: "stdio",
      command: "npx",
      args: JSON.stringify(["@kevinwatt/yt-dlp-mcp"]),
      enabled: true,
      requireApproval: true,
      bundled: true,
      installStatus: "installed",
      envVars: null,
    },
  ]).run();
});

afterEach(() => resetTestDb());

describe("listBundledMcps integration", () => {
  it("returns ElevenLabs as needs_config with redacted requiredEnvVars", async () => {
    const result = await listBundledMcps({});
    const data = result.data as { mcps: Array<{ id: string; installStatus: string; requiredEnvVars: string[]; configuredEnvVars: string[] }> };

    const eleven = data.mcps.find((m) => m.id === "elevenlabs");
    expect(eleven).toBeDefined();
    expect(eleven!.installStatus).toBe("needs_config");
    expect(eleven!.requiredEnvVars).toEqual(["ELEVENLABS_API_KEY"]);
    expect(eleven!.configuredEnvVars).toEqual([]);

    const yt = data.mcps.find((m) => m.id === "youtube-downloader");
    expect(yt).toBeDefined();
    expect(yt!.installStatus).toBe("installed");
    expect(yt!.requiredEnvVars).toEqual([]);
  });

  it("after setting ELEVENLABS_API_KEY, configuredEnvVars contains the name (not the value)", async () => {
    dbHandle.update(mcpServers)
      .set({
        envVars: JSON.stringify({ ELEVENLABS_API_KEY: "sk_secret_abc123" }),
        installStatus: "installed",
      })
      .where(eq(mcpServers.id, "elevenlabs"))
      .run();

    const result = await listBundledMcps({});
    const data = result.data as {
      mcps: Array<{ id: string; installStatus: string; configuredEnvVars: string[] }>;
    };
    const eleven = data.mcps.find((m) => m.id === "elevenlabs");
    expect(eleven?.installStatus).toBe("installed");
    expect(eleven?.configuredEnvVars).toEqual(["ELEVENLABS_API_KEY"]);
    // The secret must NOT appear in the serialized output
    expect(JSON.stringify(result)).not.toContain("sk_secret_abc123");
  });
});
