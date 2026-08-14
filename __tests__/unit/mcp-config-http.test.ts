import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema";
import { invalidateMcpConfig, getMcpServersForSettings, getMcpServersForAcp } from "@/lib/mcp-config";

describe("mcp-config HTTP support", () => {
  beforeEach(() => {
    createTestDb();
    invalidateMcpConfig();
  });
  afterEach(() => {
    resetTestDb();
    invalidateMcpConfig();
  });

  it("emits HTTP rows in settings format with envVar substitution", () => {
    getDb()
      .insert(mcpServers)
      .values({
        id: "fal-ai",
        name: "fal-ai",
        description: "fal",
        type: "http",
        command: "",
        args: "[]",
        url: "https://mcp.fal.ai/mcp",
        headers: JSON.stringify({ Authorization: "Bearer ${FAL_KEY}" }),
        envVars: JSON.stringify({ FAL_KEY: "secret" }),
        bundled: true,
        enabled: true,
        installStatus: "installed",
        dependencyStatus: "[]",
      })
      .run();
    invalidateMcpConfig();

    const settings = getMcpServersForSettings();
    expect(settings["fal-ai"]).toEqual({
      type: "http",
      url: "https://mcp.fal.ai/mcp",
      headers: { Authorization: "Bearer secret" },
    });
  });

  it("includes HTTP rows when emitting ACP entries for claude (HTTP-capable as of 2026-05-26)", () => {
    // claude-agent-acp v0.29.1+ and Claude Agent SDK v0.2.112+ support HTTP MCPs natively.
    // Verified empirically via scripts/probe-fal-http-mcp.ts.
    getDb()
      .insert(mcpServers)
      .values({
        id: "fal-ai",
        name: "fal-ai",
        description: "fal",
        type: "http",
        command: "",
        args: "[]",
        url: "https://mcp.fal.ai/mcp",
        headers: JSON.stringify({ Authorization: "Bearer ${FAL_KEY}" }),
        envVars: JSON.stringify({ FAL_KEY: "secret" }),
        bundled: true,
        enabled: true,
        installStatus: "installed",
        dependencyStatus: "[]",
      })
      .run();
    invalidateMcpConfig();

    const acp = getMcpServersForAcp("claude");
    const entry = acp.find((e) => e.name === "fal-ai");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      type: "http",
      name: "fal-ai",
      url: "https://mcp.fal.ai/mcp",
      headers: [{ name: "Authorization", value: "Bearer secret" }],
    });
  });

  it("includes HTTP rows when emitting ACP entries for codex (HTTP-capable agent)", () => {
    getDb()
      .insert(mcpServers)
      .values({
        id: "fal-ai",
        name: "fal-ai",
        description: "fal",
        type: "http",
        command: "",
        args: "[]",
        url: "https://mcp.fal.ai/mcp",
        headers: JSON.stringify({ Authorization: "Bearer ${FAL_KEY}" }),
        envVars: JSON.stringify({ FAL_KEY: "secret" }),
        bundled: true,
        enabled: true,
        installStatus: "installed",
        dependencyStatus: "[]",
      })
      .run();
    invalidateMcpConfig();

    const acp = getMcpServersForAcp("codex");
    const entry = acp.find((e) => e.name === "fal-ai");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      type: "http",
      name: "fal-ai",
      url: "https://mcp.fal.ai/mcp",
      headers: [{ name: "Authorization", value: "Bearer secret" }],
    });
  });

  it("per-agent ACP caches are populated independently for HTTP-capable agents", () => {
    // Both claude and codex are HTTP-capable as of 2026-05-26 — fal-ai appears in both.
    // The per-agent cache structure remains (still useful if future agents differ).
    getDb()
      .insert(mcpServers)
      .values({
        id: "fal-ai",
        name: "fal-ai",
        description: "fal",
        type: "http",
        command: "",
        args: "[]",
        url: "https://mcp.fal.ai/mcp",
        headers: JSON.stringify({ Authorization: "Bearer ${FAL_KEY}" }),
        envVars: JSON.stringify({ FAL_KEY: "secret" }),
        bundled: true,
        enabled: true,
        installStatus: "installed",
        dependencyStatus: "[]",
      })
      .run();
    invalidateMcpConfig();

    const claudeAcp = getMcpServersForAcp("claude");
    const codexAcp = getMcpServersForAcp("codex");

    expect(claudeAcp.find((e) => e.name === "fal-ai")).toBeDefined();
    expect(codexAcp.find((e) => e.name === "fal-ai")).toBeDefined();
  });

  it("includes HTTP rows when agentId is the internal 'claude-code' identifier", () => {
    // Regression: SessionManager passes the internal agent id from
    // lib/agents/acp/agent-registry.ts (currently "claude-code", not "claude").
    // The old ACP_HTTP_CAPABLE set only contained "claude" which silently dropped
    // fal-ai from claude-code sessions — exactly the Phase 4 blocker.
    getDb()
      .insert(mcpServers)
      .values({
        id: "fal-ai",
        name: "fal-ai",
        description: "fal",
        type: "http",
        command: "",
        args: "[]",
        url: "https://mcp.fal.ai/mcp",
        headers: JSON.stringify({ Authorization: "Bearer ${FAL_KEY}" }),
        envVars: JSON.stringify({ FAL_KEY: "secret" }),
        bundled: true,
        enabled: true,
        installStatus: "installed",
        dependencyStatus: "[]",
      })
      .run();
    invalidateMcpConfig();

    const acp = getMcpServersForAcp("claude-code");
    const entry = acp.find((e) => e.name === "fal-ai");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      type: "http",
      name: "fal-ai",
      url: "https://mcp.fal.ai/mcp",
      headers: [{ name: "Authorization", value: "Bearer secret" }],
    });
  });

  it("HTTP row blocked at settings level if installStatus is needs_config", () => {
    getDb()
      .insert(mcpServers)
      .values({
        id: "fal-ai",
        name: "fal-ai",
        description: "fal",
        type: "http",
        command: "",
        args: "[]",
        url: "https://mcp.fal.ai/mcp",
        headers: JSON.stringify({ Authorization: "Bearer ${FAL_KEY}" }),
        envVars: "{}",
        bundled: true,
        enabled: true,
        installStatus: "needs_config",
        dependencyStatus: "[]",
      })
      .run();
    invalidateMcpConfig();

    const settings = getMcpServersForSettings();
    expect(settings["fal-ai"]).toBeUndefined();
  });

  it("preserves stdio row formatting unchanged", () => {
    getDb()
      .insert(mcpServers)
      .values({
        id: "youtube-downloader",
        name: "youtube-downloader",
        description: "yt",
        type: "stdio",
        command: "npx",
        args: JSON.stringify(["-y", "@kevinwatt/yt-dlp-mcp@latest"]),
        envVars: "{}",
        bundled: true,
        enabled: true,
        installStatus: "installed",
        dependencyStatus: "[]",
      })
      .run();
    invalidateMcpConfig();

    const settings = getMcpServersForSettings();
    // For managed bundled MCPs (those with `npmPackage` + `pinnedVersion`),
    // the def is the source of truth for spawn command/args, not the DB row.
    // No local install exists in this test, so we get the npx fallback at
    // the pinned version.
    expect(settings["youtube-downloader"]).toMatchObject({
      command: "npx",
      args: ["-y", "@kevinwatt/yt-dlp-mcp@0.9.0"],
    });
    // No `type` field on stdio entries (they're plain {command, args, env})
    expect((settings["youtube-downloader"] as { type?: unknown }).type).toBeUndefined();
  });
});
