/**
 * The scene tools are gone, and stay gone.
 *
 * `libi.create_scene` was the ONLY thing in the codebase that could produce a
 * canvas scene — storyboard take-selection places an overlay, video import
 * creates a VideoOverlay, and video scenes were retired in 2026-07-19. A scene
 * had no startTime, rect, z or opacity, so anything it made was a layer the
 * editor could not move, resize, restack or hide. Removing the tool is what
 * makes that unrepeatable; this test is what keeps it removed.
 *
 * Asserted through a REAL `tools/list` rather than by grepping server.ts,
 * because the failure mode this guards against is a conversion failure: a
 * schema imported from "zod" instead of "zod/v3" makes the SDK's JSON-schema
 * conversion fail silently and every tool vanish. A suite of `not.toContain`
 * assertions passes perfectly against an empty list — hence the canary below.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLibiMcpServer } from "@/mcp/server";

const RETIRED = [
  "libi.create_scene",
  "libi.update_scene",
  "libi.delete_scene",
  "libi.reorder_scenes",
  "libi.load_scene",
];

async function listToolNames(): Promise<string[]> {
  const server = createLibiMcpServer();
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("scene tools are retired", () => {
  it("registers none of the five scene tools", async () => {
    const names = await listToolNames();

    // THE CANARY. Without this, a silently empty tool list would make every
    // assertion below pass while the whole MCP surface was broken.
    expect(names).toContain("libi.add_overlay");
    expect(names.length).toBeGreaterThan(50);

    for (const gone of RETIRED) expect(names, gone).not.toContain(gone);
  });

  it("keeps the overlay tool that replaced them", async () => {
    // A hand-drawn full-frame graphic is a `code` overlay now. If this ever
    // disappears there is no way to author one at all.
    const names = await listToolNames();
    expect(names).toContain("libi.add_overlay");
    expect(names).toContain("libi.update_overlay");
  });
});
