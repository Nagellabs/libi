/** Through a REAL tools/list, as assign-file-registration.test.ts does: a zod-v4 schema would drop every tool silently. */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLibiMcpServer } from "@/mcp/server";

async function listTools() {
  const server = createLibiMcpServer();
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.listTools();
  } finally {
    await client.close();
    await server.close();
  }
}

describe("libi.list_exports is reachable over MCP", () => {
  it("is listed with pieceId required and the status enum", async () => {
    const { tools } = await listTools();
    expect(tools.length).toBeGreaterThan(50);
    const tool = tools.find((t) => t.name === "libi.list_exports");
    expect(tool).toBeTruthy();
    expect(tool!.inputSchema.required).toContain("pieceId");
    const props = tool!.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.status.enum).toEqual(["queued", "running", "done", "failed", "cancelled"]);
  });

  it("libi.export_video says destFolder is removed and exports live in the piece", async () => {
    const { tools } = await listTools();
    const tool = tools.find((t) => t.name === "libi.export_video")!;
    expect(tool.description).toMatch(/Exports tab/);
    expect(tool.description).not.toMatch(/configured export folder/);
    const props = tool.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.destFolder.description).toMatch(/^REMOVED/);
  });

  it("libi.export_video takes 1–10 variants", async () => {
    const { tools } = await listTools();
    const tool = tools.find((t) => t.name === "libi.export_video")!;
    const variants = (tool.inputSchema.properties as Record<string, { type?: string; minItems?: number; maxItems?: number }>).variants;
    expect(variants).toMatchObject({ type: "array", minItems: 1, maxItems: 10 });
    expect(tool.description).toMatch(/variants/);
  });
});
