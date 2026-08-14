import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTrackingTools } from "./register-tracking-tools";
import { installArgCoercion } from "@/mcp/tools/coerce-args";
import { trackToolUsed, wrapRegisterToolWithTracking } from "@/mcp/analytics";

/** The standalone `libi-tracking` MCP (CLI: `libi serve-mcp-tracking`).
 *
 *  As of the always-on-tracking fix the tracking + background-removal tools are ALSO
 *  registered on the core `libi` MCP (`mcp/server.ts`) via the shared
 *  `registerTrackingTools()` — so the agent always has them regardless of
 *  whether this standalone server is spawned. This factory is retained for
 *  packaging parity (a dedicated tracking MCP process) and uses the exact
 *  same registration, so the two surfaces can never drift. The tracking
 *  engine remains lazy/tier-2; only the tool surface is always-on. */
export function createTrackingMcpServer(): McpServer {
  const server = new McpServer({ name: "libi-tracking", version: "0.1.0" });
  installArgCoercion(server);
  // Emit `tool_used` for tracking tools when this standalone MCP is spawned.
  // (On the core libi server the same tools are already wrapped via mcp/server.ts.)
  {
    const orig = server.registerTool.bind(server);
    (server as unknown as { registerTool: (...a: unknown[]) => unknown }).registerTool =
      wrapRegisterToolWithTracking(orig as (...a: unknown[]) => unknown, trackToolUsed);
  }
  registerTrackingTools(server);
  return server;
}
