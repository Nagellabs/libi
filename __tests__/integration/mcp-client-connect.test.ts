/**
 * Integration test: connect to the libi MCP server as a client.
 *
 * Spawns the actual MCP server (via tsx) and connects to it using the
 * MCP SDK's StdioClientTransport — the same way Claude Code would.
 * Verifies the handshake completes and tools are listed correctly.
 */

import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const TSX_BIN = path.join(PROJECT_ROOT, "node_modules", ".bin", "tsx");
const TSCONFIG = path.join(PROJECT_ROOT, "tsconfig.json");
const MCP_ENTRY = path.join(PROJECT_ROOT, "mcp", "index.ts");

describe("MCP client → libi server", () => {
  let transport: StdioClientTransport | null = null;
  let client: Client | null = null;

  afterEach(async () => {
    try { await client?.close(); } catch { /* ignore */ }
    try { await transport?.close(); } catch { /* ignore */ }
    client = null;
    transport = null;
  });

  it("connects, initializes, and lists all tools", async () => {
    transport = new StdioClientTransport({
      command: TSX_BIN,
      args: ["--tsconfig", TSCONFIG, MCP_ENTRY],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([, v]) => typeof v === "string",
        ) as [string, string][],
      ),
    });

    client = new Client({
      name: "libi-test-client",
      version: "1.0.0",
    });

    // Connect and initialize (same as Claude Code would do)
    await client.connect(transport);

    // List tools
    const result = await client.listTools();

    console.log(`\n=== MCP Tools Listed: ${result.tools.length} ===`);
    for (const tool of result.tools) {
      console.log(`  - ${tool.name}: ${tool.description?.slice(0, 80)}...`);
    }
    console.log("");

    // Verify we get tools
    expect(result.tools.length).toBeGreaterThan(0);

    // Verify specific tools exist
    const toolNames = result.tools.map(t => t.name);
    expect(toolNames).toContain("libi.add_overlay");
    expect(toolNames).toContain("libi.get_composition");
    expect(toolNames).toContain("libi.list_pieces");
    expect(toolNames).toContain("libi.get_version");
    expect(toolNames).toContain("libi.list_jobs");

    // libi.list_jobs exists so an agent can discover work it has no jobId for —
    // the situation that made it report "nothing has been downloaded" over a
    // running 6 GB download (session 9c3ce4d0). Every filter must actually reach
    // the agent: a silently-empty inputSchema would leave it guessing arguments,
    // which is the exact failure mode the compute_object_track regression below
    // documents.
    const listJobsTool = result.tools.find((t) => t.name === "libi.list_jobs");
    expect(listJobsTool).toBeTruthy();
    const listJobsProps = (listJobsTool!.inputSchema.properties ?? {}) as Record<
      string,
      unknown
    >;
    expect(listJobsProps).toHaveProperty("status");
    expect(listJobsProps).toHaveProperty("kind");
    expect(listJobsProps).toHaveProperty("limit");

    // Verify each tool has required fields
    for (const tool of result.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      // inputSchema should be a valid JSON schema object (or undefined for no-arg tools)
      if (tool.inputSchema) {
        expect(tool.inputSchema.type).toBe("object");
      }
    }

    // Regression: compute_object_track is the only tracking tool whose
    // schema was built with `z.object(...).refine(...)`. A Zod-v3 `.refine()`
    // is a ZodEffects with NO `.shape`, so the MCP SDK's
    // `normalizeObjectSchema` returned undefined and published an EMPTY
    // inputSchema — the agent then saw a parameterless tool and blind-guessed
    // its arguments. The fix registers the raw shape; assert the agent now
    // sees the full parameter list.
    const cot = result.tools.find((t) => t.name === "libi.compute_object_track");
    expect(cot).toBeTruthy();
    expect(cot!.inputSchema).toBeTruthy();
    expect(cot!.inputSchema.type).toBe("object");
    const cotProps = (cot!.inputSchema.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(cotProps).length).toBeGreaterThan(0);
    expect(cotProps).toHaveProperty("fileId");
    expect(cotProps).toHaveProperty("objectKind");
    expect(cotProps).toHaveProperty("anchors");
    expect(cotProps).toHaveProperty("derivedFromSubjectName");

    // Same root cause for the paid providers variant.
    const cotp = result.tools.find(
      (t) => t.name === "libi.compute_object_track_providers",
    );
    expect(cotp).toBeTruthy();
    const cotpProps = (cotp!.inputSchema?.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(cotpProps).length).toBeGreaterThan(0);
    expect(cotpProps).toHaveProperty("fileId");
    expect(cotpProps).toHaveProperty("provider");

    // Log the full JSON for debugging if needed
    if (process.env.LIBI_DEBUG) {
      console.log("\n=== Full tools/list response ===");
      console.log(JSON.stringify(result, null, 2));
    }
  }, 30_000); // 30s timeout for tsx startup
});
