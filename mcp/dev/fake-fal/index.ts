import { mcpLogger as logger } from "@/lib/logger";
import { ensureLibiDirs } from "@/lib/libi-home";
import { createFakeFalMcpServer } from "@/mcp/dev/fake-fal/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main() {
  ensureLibiDirs();
  const server = createFakeFalMcpServer();
  await server.connect(new StdioServerTransport());
  logger.info({ tag: "fake-fal" }, "fake-fal MCP running (stdio, masquerading as fal-ai)");
}
main().catch((err) => { logger.fatal({ err, tag: "fake-fal" }, "fake-fal MCP failed to start"); setTimeout(() => process.exit(1), 100); });
