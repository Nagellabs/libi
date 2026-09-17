import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Where a tool name goes. Only one source exists (libi itself), kept as a
 *  named type so the session's routing stays explicit. */
export interface ToolRoute { source: string; upstreamName: string }
export interface ToolTable {
  tools: Tool[];
  routes: Map<string, ToolRoute>;
}

/**
 * Build the routing table for libi's own tools. Names pass through verbatim —
 * skills and the manual refer to tools by their registered names.
 *
 * The collision/rename machinery this file used to carry existed only to merge
 * third-party upstreams; libi proxies none. A duplicate here would
 * be a libi bug in `mcp/server.ts`, not something to paper over at runtime, so
 * it throws.
 */
export function buildToolTable(source: string, tools: Tool[]): ToolTable {
  const routes = new Map<string, ToolRoute>();
  for (const tool of tools) {
    if (routes.has(tool.name)) {
      throw new Error(`duplicate tool name registered on the libi server: ${tool.name}`);
    }
    routes.set(tool.name, { source, upstreamName: tool.name });
  }
  return { tools, routes };
}
