import { mcpLogger as logger } from "@/lib/logger";
import { ensureLibiDirs } from "@/lib/libi-home";
import { createLibiMcpServer } from "@/mcp/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function serveMcp() {
  ensureLibiDirs();

  logger.info("Loading MCP server...");

  const server = createLibiMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("MCP server running (stdio mode)");
}
