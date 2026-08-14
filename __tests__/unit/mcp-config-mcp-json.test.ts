import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema";
import { invalidateMcpConfig, writeSettingsFile } from "@/lib/mcp-config";

describe("writeSettingsFile — Claude Code project MCP discovery", () => {
  let tmp: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-mcpjson-"));
    process.env.LIBI_CONNECT_AGENT_DIR = tmp;
    createTestDb();
    invalidateMcpConfig();
  });

  afterEach(() => {
    resetTestDb();
    invalidateMcpConfig();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it("writes libi into <workspace>/.mcp.json (the file Claude Code reads)", () => {
    writeSettingsFile(tmp);
    const mcpJson = JSON.parse(fs.readFileSync(path.join(tmp, ".mcp.json"), "utf-8"));
    expect(mcpJson.mcpServers.libi).toBeDefined();
    expect(mcpJson.mcpServers.libi.command).toBeTruthy();
  });

  it("sets enableAllProjectMcpServers and drops the ignored mcpServers block in settings.local.json", () => {
    writeSettingsFile(tmp);
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmp, ".claude", "settings.local.json"), "utf-8"),
    );
    expect(settings.enableAllProjectMcpServers).toBe(true);
    expect(settings.mcpServers).toBeUndefined();
  });

  it("preserves a user's own .mcp.json server and pre-existing settings keys", () => {
    fs.writeFileSync(
      path.join(tmp, ".mcp.json"),
      JSON.stringify({ mcpServers: { "user-thing": { command: "user-bin" } } }) + "\n",
    );
    fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Bash"] } }) + "\n",
    );

    writeSettingsFile(tmp);

    const mcpJson = JSON.parse(fs.readFileSync(path.join(tmp, ".mcp.json"), "utf-8"));
    expect(mcpJson.mcpServers["user-thing"]).toEqual({ command: "user-bin" });
    expect(mcpJson.mcpServers.libi).toBeDefined();

    const settings = JSON.parse(
      fs.readFileSync(path.join(tmp, ".claude", "settings.local.json"), "utf-8"),
    );
    expect(settings.permissions).toEqual({ allow: ["Bash"] });
    expect(settings.enableAllProjectMcpServers).toBe(true);
  });

  it("writes a SECRET-FREE .mcp.json — no inherited API keys land on disk", () => {
    // A secret present in the process env would be inlined by buildSpawnEnv into
    // a stdio server's env; the writer must strip it (YouTube Downloader
    // requiredEnvVars: []).
    process.env.LIBI_TEST_FAKE_SECRET = "sk-should-not-persist";
    getDb()
      .insert(mcpServers)
      .values({
        id: "youtube-downloader",
        name: "YouTube Downloader",
        description: "",
        type: "stdio",
        command: "npx",
        args: '["-y","@kevinwatt/yt-dlp-mcp@0.9.0"]',
        envVars: "{}",
        bundled: true,
        enabled: true,
        installStatus: "installed",
        dependencyStatus: "[]",
      })
      .run();
    invalidateMcpConfig();

    writeSettingsFile(tmp);

    const raw = fs.readFileSync(path.join(tmp, ".mcp.json"), "utf-8");
    // The secret must not appear ANYWHERE in the file (key or value).
    expect(raw).not.toContain("LIBI_TEST_FAKE_SECRET");
    expect(raw).not.toContain("sk-should-not-persist");

    const yt = JSON.parse(raw).mcpServers["YouTube Downloader"];
    expect(yt).toBeDefined();
    expect(yt.env).not.toHaveProperty("LIBI_TEST_FAKE_SECRET");
    expect(yt.env.LIBI_HOME).toBeTruthy(); // home pinned
  });

  it("recovers from a wrong-shape (non-object) existing .mcp.json", () => {
    fs.writeFileSync(path.join(tmp, ".mcp.json"), "[]\n");
    writeSettingsFile(tmp);
    const mcpJson = JSON.parse(fs.readFileSync(path.join(tmp, ".mcp.json"), "utf-8"));
    expect(mcpJson.mcpServers.libi).toBeDefined();
  });

  it("refreshes libi-managed servers (drops a now-absent managed entry, keeps libi)", () => {
    getDb().insert(mcpServers).values({
      id: "youtube-downloader", name: "YouTube Downloader", description: "", type: "stdio",
      command: "yt-dlp-bin", args: "[]", envVars: "{}",
      bundled: true, enabled: false, installStatus: "installed", dependencyStatus: "[]",
    }).run();
    invalidateMcpConfig();

    fs.writeFileSync(
      path.join(tmp, ".mcp.json"),
      JSON.stringify({ mcpServers: { "YouTube Downloader": { command: "stale" }, libi: { command: "stale" } } }) + "\n",
    );

    writeSettingsFile(tmp);

    const mcpJson = JSON.parse(fs.readFileSync(path.join(tmp, ".mcp.json"), "utf-8"));
    expect(mcpJson.mcpServers["YouTube Downloader"]).toBeUndefined();
    expect(mcpJson.mcpServers.libi.command).not.toBe("stale");
  });
});

describe("invalidateMcpConfig — connect-agent dual-target write", () => {
  it("writes .mcp.json to BOTH the default and the connected agent dir", async () => {
    const { getLibiAgentDir } = await import("@/lib/libi-home");
    const connected = fs.mkdtempSync(path.join(os.tmpdir(), "libi-connected-"));
    process.env.LIBI_CONNECT_AGENT_DIR = connected;
    createTestDb();
    try {
      invalidateMcpConfig({ reason: "test" });
      // Both files must exist AND carry the libi server entry (not a stray
      // empty/leftover file) — a real correctness check on the loop reaching
      // both dirs.
      const defaultMcp = JSON.parse(
        fs.readFileSync(path.join(getLibiAgentDir(), ".mcp.json"), "utf-8"),
      );
      const connectedMcp = JSON.parse(
        fs.readFileSync(path.join(connected, ".mcp.json"), "utf-8"),
      );
      expect(defaultMcp.mcpServers?.libi).toBeDefined();
      expect(connectedMcp.mcpServers?.libi).toBeDefined();
    } finally {
      resetTestDb();
      delete process.env.LIBI_CONNECT_AGENT_DIR;
      fs.rmSync(connected, { recursive: true, force: true });
    }
  });
});
