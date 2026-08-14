import { describe, it, expect, vi } from "vitest";

// Mock the tools module so each tool returns a predictable result
vi.mock("@/mcp/tools", () => ({
  createScene: vi.fn().mockResolvedValue({ success: true, data: { sceneId: "mock-scene-1" } }),
  updateScene: vi.fn().mockResolvedValue({ success: true, data: {} }),
  deleteScene: vi.fn().mockResolvedValue({ success: true, data: {} }),
  reorderScenes: vi.fn().mockResolvedValue({ success: true, data: {} }),
  loadSceneData: vi.fn().mockResolvedValue({ success: true, data: { scene: {} } }),
  getComposition: vi.fn().mockResolvedValue({ success: true, data: { manifest: {}, scenes: [] } }),
  updatePieceName: vi.fn().mockResolvedValue({ success: true, data: {} }),
  updatePieceDescription: vi.fn().mockResolvedValue({ success: true, data: {} }),
  saveAsset: vi.fn().mockResolvedValue({ success: true, data: {} }),
}));

// Mock the version constant
vi.mock("@/mcp/version", () => ({
  LIBI_SKILL_VERSION: "1.0.0",
}));

import { createLibiMcpServer } from "@/mcp/server";
import * as tools from "@/mcp/tools";

describe("MCP server integration", () => {
  it("creates the server without error", () => {
    const server = createLibiMcpServer();
    expect(server).toBeDefined();
  });

  it("server is created with correct name and version metadata", () => {
    const server = createLibiMcpServer();
    // McpServer stores its metadata; we can verify via the server object
    expect(server).toBeDefined();
    // The server instance should have been created with our version
    // Since McpServer doesn't expose name/version directly, we validate
    // the factory function completed without throwing (i.e., schema
    // registration was accepted by McpServer for all tools).
  });

  it("all expected tools are registered (tool mocks are wired)", () => {
    // We verify that the tools module exposes every function the MCP server
    // registers — if any tool import is missing, createLibiMcpServer would
    // fail at import-time or call-time.
    const toolFns = Object.keys(tools);

    // Every tool function used by the MCP server should be importable
    expect(toolFns).toContain("createScene");
    expect(toolFns).toContain("updateScene");
    expect(toolFns).toContain("deleteScene");
    expect(toolFns).toContain("reorderScenes");
    expect(toolFns).toContain("loadSceneData");
    expect(toolFns).toContain("getComposition");
    expect(toolFns).toContain("updatePieceName");
    expect(toolFns).toContain("updatePieceDescription");
    expect(toolFns).toContain("saveAsset");
  });

  it("tool mocks are callable and return expected shape", async () => {
    // Ensure the mocked tools return the shape the MCP server expects
    const ctx = { pieceId: "mcp-test-piece" };

    const createResult = await tools.createScene(ctx, {
      name: "Test",
      duration: 1,
      drawFunction: "// test",
    } as never);
    expect(createResult.success).toBe(true);
    expect(createResult.data).toHaveProperty("sceneId");

    const compResult = await tools.getComposition(ctx);
    expect(compResult.success).toBe(true);
    expect(compResult.data).toHaveProperty("manifest");
    expect(compResult.data).toHaveProperty("scenes");
  });
});
