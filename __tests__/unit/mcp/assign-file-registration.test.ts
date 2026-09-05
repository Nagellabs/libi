/**
 * `libi.assign_file` is registered in mcp/server.ts, but the only other test
 * for it (assign-file-tool.test.ts) imports `assignFileSchema` from
 * mcp/tools/schemas.ts directly — it never starts the server or lists tools.
 * That leaves a hole: deleting the whole `server.registerTool("libi.assign_file", …)`
 * block would leave that suite green while the tool vanished from `tools/list`
 * and every caller (mcp/tools/overlay-tools.ts, mcp/templates/instructions.md,
 * mcp/skills/using-object-tracking/SKILL.md) started sending agents to
 * "unknown tool".
 *
 * Asserted through a REAL `tools/list`, for the same reason as
 * no-scene-tools.test.ts: the failure mode this guards against is a silent
 * JSON-schema conversion failure (a schema built on "zod" instead of
 * "zod/v3" makes the SDK drop every tool from the list), which a plain
 * schema-object test cannot see.
 */
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

describe("libi.assign_file is reachable over MCP", () => {
  it("is present in tools/list", async () => {
    const { tools } = await listTools();
    const names = tools.map((t) => t.name);

    // THE CANARY. Without this, a silently empty tool list would make the
    // assertion below pass for the wrong reason.
    expect(names).toContain("libi.add_overlay");
    expect(names.length).toBeGreaterThan(50);

    expect(names).toContain("libi.assign_file");
  });

  it("keeps fileId and a nullable pieceId in the converted inputSchema", async () => {
    // This is the assertion that actually guards the zod v3/v4 hazard: under
    // zod v4 the SDK's JSON-schema conversion fails SILENTLY and the tool
    // disappears from tools/list entirely — a schema-object unit test can't
    // see that, but reading the schema back off a real tools/list can.
    const { tools } = await listTools();
    const tool = tools.find((t) => t.name === "libi.assign_file");
    expect(tool).toBeTruthy();
    expect(tool!.inputSchema.type).toBe("object");

    const props = (tool!.inputSchema.properties ?? {}) as Record<
      string,
      { type?: string | string[] }
    >;
    expect(props).toHaveProperty("fileId");
    expect(props).toHaveProperty("pieceId");

    // pieceId: null means "unassign" — the un-assign direction is half the
    // tool's purpose (see assign-file-tool.test.ts). A JSON-schema nullable
    // zod/v3 field converts to a union type array containing "null".
    const pieceIdType = props.pieceId?.type;
    expect(Array.isArray(pieceIdType) ? pieceIdType : [pieceIdType]).toContain("null");
  });
});
