/**
 * Standalone MCP server entry point.
 *
 * Run directly with tsx: `tsx mcp/index.ts`
 * Or via the CLI: `npx libi serve-mcp`
 *
 * Connects the Libi MCP server to stdio transport.
 * All tool calls execute in-process (direct DB/storage access).
 * Logs are written to ~/.libi/logs/mcp-server.log
 */

// Import logger first — sets up file logging and crash handlers
import { mcpLogger as logger } from "@/lib/logger";
import { ensureLibiDirs } from "@/lib/libi-home";
import { createLibiMcpServer } from "@/mcp/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main() {
  ensureLibiDirs();
  // MCP children DO NOT migrate the DB — the parent (libi server) is
  // responsible for that via the lifecycle prelude. If you're getting
  // "no such table" errors here, the parent didn't migrate before
  // spawning us. In tests, call migrateDatabase() in `beforeAll` against
  // your temp LIBI_HOME path before spawning the MCP child.

  // JobManager runs in the Next.js process. MCP-side tools that need to
  // invoke jobs use `mcp/jobs-client.ts`, which talks to the Next.js
  // server over HTTP. The runner registry intentionally does NOT exist
  // in this process.

  logger.info("Loading MCP server...");

  const server = createLibiMcpServer();
  const transport = new StdioServerTransport();

  // LIBI_DEBUG=1 enables MCP transport tracing
  if (process.env.LIBI_DEBUG) {
    const origOnMessage = transport.onmessage;
    transport.onmessage = (msg) => {
      logger.debug({ method: (msg as { method?: string }).method }, "MCP ← received");
      origOnMessage?.(msg);
    };
    transport.onerror = (err) => logger.error({ err }, "MCP transport error");
    transport.onclose = () => logger.warn("MCP transport closed");
  }

  await server.connect(transport);

  logger.info("MCP server running (stdio mode)");
}

main().catch((err) => {
  logger.fatal({ err }, "MCP server failed to start");
  setTimeout(() => process.exit(1), 100);
});
