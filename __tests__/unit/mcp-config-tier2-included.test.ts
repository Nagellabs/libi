import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema";
import { invalidateMcpConfig, getMcpServersForSettings } from "@/lib/mcp-config";

describe("mcp-config — tier-2 MCPs included by default", () => {
  beforeEach(() => {
    createTestDb();
    invalidateMcpConfig();
  });
  afterEach(() => {
    resetTestDb();
    invalidateMcpConfig();
  });

  it("includes a tier-2 MCP whose installStatus is 'pending' (no API key required)", () => {
    getDb()
      .insert(mcpServers)
      .values({
        id: "youtube-downloader",
        name: "YouTube Downloader",
        description: "test",
        type: "stdio",
        command: "npx",
        args: JSON.stringify(["-y", "@kevinwatt/yt-dlp-mcp@0.8.4"]),
        envVars: "{}",
        bundled: true,
        enabled: true,
        installStatus: "pending",
        dependencyStatus: "[]",
      })
      .run();
    invalidateMcpConfig();

    const servers = getMcpServersForSettings();
    expect(servers["YouTube Downloader"]).toBeDefined();
  });

  it("excludes a tier-2 MCP whose installStatus is 'needs_config'", () => {
    getDb()
      .insert(mcpServers)
      .values({
        id: "elevenlabs",
        name: "ElevenLabs",
        description: "test",
        type: "stdio",
        command: "uvx",
        args: JSON.stringify(["elevenlabs-mcp"]),
        envVars: "{}",
        bundled: true,
        enabled: true,
        installStatus: "needs_config",
        dependencyStatus: "[]",
      })
      .run();
    invalidateMcpConfig();

    const servers = getMcpServersForSettings();
    expect(servers["ElevenLabs"]).toBeUndefined();
  });

  it("excludes a tier-2 MCP whose installStatus is 'failed'", () => {
    getDb()
      .insert(mcpServers)
      .values({
        id: "x", name: "X", description: "", type: "stdio",
        command: "npx", args: "[]", envVars: "{}", bundled: true,
        enabled: true, installStatus: "failed", dependencyStatus: "[]",
      })
      .run();
    invalidateMcpConfig();
    expect(getMcpServersForSettings()["X"]).toBeUndefined();
  });
});
