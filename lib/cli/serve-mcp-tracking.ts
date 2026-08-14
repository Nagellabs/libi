import { mcpLogger as logger } from "@/lib/logger";
import { ensureLibiDirs } from "@/lib/libi-home";
import { createTrackingMcpServer } from "@/mcp/tracking-mcp/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function serveTrackingMcp() {
  ensureLibiDirs();

  logger.info("Loading libi-tracking MCP server...");

  const server = createTrackingMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("libi-tracking MCP server running (stdio mode)");
}
