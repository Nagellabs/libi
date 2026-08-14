import { describe, it, expect } from "vitest";
import { buildExternalToolsSection } from "@/mcp/registry/instruction-builder";
import type { McpServerRecord } from "@/lib/db/schema/types";

function makeMcpRow(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: "test-mcp",
    name: "Test MCP",
    description: "A test MCP server",
    npmUrl: null,
    type: "stdio",
    command: "npx",
    args: '["test-mcp"]',
    url: null,
    headers: null,
    envVars: null,
    enabled: true,
    requireApproval: false,
    bundled: false,
    installStatus: "installed",
    installError: null,
    dependencyStatus: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("buildExternalToolsSection", () => {
  it("returns empty string when no external MCPs exist", () => {
    const result = buildExternalToolsSection([]);
    expect(result).toBe("");
  });

  it("lists available MCP without approval note", () => {
    const result = buildExternalToolsSection([makeMcpRow()]);
    expect(result).toContain("Test MCP");
    expect(result).toContain("A test MCP server");
    expect(result).not.toContain("REQUIRES APPROVAL");
  });

  it("adds approval warning for requireApproval MCPs", () => {
    const result = buildExternalToolsSection([
      makeMcpRow({ requireApproval: true }),
    ]);
    expect(result).toContain("REQUIRES APPROVAL");
  });

  it("lists failed MCPs in unavailable section", () => {
    const result = buildExternalToolsSection([
      makeMcpRow({ installStatus: "failed", installError: "binary not found", enabled: true }),
    ]);
    expect(result).toContain("unavailable");
    expect(result).toContain("binary not found");
  });

  it("skips disabled MCPs entirely", () => {
    const result = buildExternalToolsSection([
      makeMcpRow({ enabled: false }),
    ]);
    expect(result).toBe("");
  });

  it("includes agentInstructions for bundled MCPs", () => {
    const result = buildExternalToolsSection([
      makeMcpRow({
        id: "youtube-downloader",
        name: "YouTube Downloader",
        installStatus: "installed",
      }),
    ]);
    expect(result).toContain("libi.upload_file");
    expect(result).toContain("YouTube Downloader");
  });
});
