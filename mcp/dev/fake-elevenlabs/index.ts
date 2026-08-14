import { mcpLogger as logger } from "@/lib/logger";
import { ensureLibiDirs } from "@/lib/libi-home";
import { createFakeElevenLabsMcpServer } from "@/mcp/dev/fake-elevenlabs/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main() {
  ensureLibiDirs();
  const server = createFakeElevenLabsMcpServer();
  await server.connect(new StdioServerTransport());
  logger.info({ tag: "fake-elevenlabs" }, "fake-elevenlabs MCP running (stdio, masquerading as ElevenLabs)");
}
main().catch((err) => { logger.fatal({ err, tag: "fake-elevenlabs" }, "fake-elevenlabs MCP failed to start"); setTimeout(() => process.exit(1), 100); });
