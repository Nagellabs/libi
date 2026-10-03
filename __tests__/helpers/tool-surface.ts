/**
 * What an agent reads about libi's tools BEFORE it opens any skill: each tool's name, description and
 * the descriptions of its arguments, as `tools/list` serves them. Used by invariants whose rule may
 * live in a tool's own description instead of a skill (a skill folded into the tools, K5).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { collapse } from "./skill-graph";

interface ToolEntry {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Every `description` string nested anywhere in a JSON schema, joined. */
function schemaDescriptions(schema: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "description" && typeof v === "string") out.push(v);
        else walk(v);
      }
    }
  };
  walk(schema);
  return out;
}

let memo: Promise<ToolEntry[]> | null = null;

export function listLibiTools(): Promise<ToolEntry[]> {
  memo ??= (async () => {
    // Imported lazily: the server pulls in the whole mcp/ surface, which a text-only test should not pay for.
    const { createLibiMcpServer } = await import("@/mcp/server");
    const server = createLibiMcpServer();
    const client = new Client({ name: "skill-invariants", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      return (await client.listTools()).tools as ToolEntry[];
    } finally {
      await client.close();
      await server.close();
    }
  })();
  return memo;
}

/** The named tools' (all tools' when none are named) descriptions plus argument descriptions, whitespace collapsed. */
export async function toolSurfaceText(names?: readonly string[]): Promise<string> {
  const tools = await listLibiTools();
  return collapse(
    tools
      .filter((t) => !names || names.includes(t.name))
      .map((t) => [t.name, t.description ?? "", ...schemaDescriptions(t.inputSchema)].join(" "))
      .join("\n\n"),
  );
}
