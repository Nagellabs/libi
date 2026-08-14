import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { invalidateMcpConfig } from "@/lib/mcp-config";

describe("mcp/settings", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-settings-test-"));
    createTestDb();
    invalidateMcpConfig();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetTestDb();
    invalidateMcpConfig();
  });

  it("writes .mcp.json with libi MCP server and settings.local.json with enableAllProjectMcpServers", async () => {
    const { writeAllAgentConfigs } = await import("@/mcp/settings");
    writeAllAgentConfigs(tmpDir);

    // settings.local.json should have enableAllProjectMcpServers but no mcpServers
    const settingsPath = path.join(tmpDir, ".claude", "settings.local.json");
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(settings.enableAllProjectMcpServers).toBe(true);
    expect(settings.mcpServers).toBeUndefined();

    // .mcp.json should have the libi server definition
    const mcpJsonPath = path.join(tmpDir, ".mcp.json");
    expect(fs.existsSync(mcpJsonPath)).toBe(true);
    const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
    expect(mcpJson.mcpServers.libi).toBeDefined();
    // Runs mcp/index.ts via tsx's CLI entry point (node_modules/tsx/dist/cli.mjs)
    // through a plain `node` — not node_modules/.bin/tsx, which packaged
    // Electron builds never ship (see lib/mcp-config.ts#buildLibiEntry).
    expect(mcpJson.mcpServers.libi.command).toMatch(/(^|[\\/])node(\.exe)?$/);
    expect(mcpJson.mcpServers.libi.args).toEqual(
      expect.arrayContaining([
        expect.stringContaining(path.join("node_modules", "tsx", "dist", "cli.mjs")),
        expect.stringContaining("mcp/index.ts"),
      ])
    );
  });

  it("preserves existing settings when updating", async () => {
    const claudeDir = path.join(tmpDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "settings.local.json"),
      JSON.stringify({ someOtherSetting: true })
    );

    const { writeAllAgentConfigs } = await import("@/mcp/settings");
    writeAllAgentConfigs(tmpDir);

    const settings = JSON.parse(
      fs.readFileSync(path.join(claudeDir, "settings.local.json"), "utf-8")
    );
    expect(settings.someOtherSetting).toBe(true);
    expect(settings.enableAllProjectMcpServers).toBe(true);
    // libi server definition is now in .mcp.json, not settings.local.json
    expect(settings.mcpServers).toBeUndefined();
  });
});
