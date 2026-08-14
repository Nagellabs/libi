import { mcpLogger as logger } from "@/lib/logger";
import { ensureLibiDirs } from "@/lib/libi-home";
import { createTrackingMcpServer } from "@/mcp/tracking-mcp/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main() {
  ensureLibiDirs();
  logger.info("Loading libi-tracking MCP server...");
  const server = createTrackingMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("libi-tracking MCP server running (stdio mode)");
}

main().catch((err) => {
  logger.fatal({ err }, "libi-tracking MCP server failed to start");
  setTimeout(() => process.exit(1), 100);
});
