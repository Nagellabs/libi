import { mcpLogger as logger } from "@/lib/logger";
import { ensureLibiDirs } from "@/lib/libi-home";
import { createLibiMcpServer } from "@/mcp/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * libi's own tools on STDIO — the whole of what `libi serve-mcp` and
 * `mcp/index.ts` each do.
 *
 * There are two ways in and ONE implementation, which there had not been:
 * `mcp/index.ts` carried its own copy, and the copies had drifted (only that
 * one had the `LIBI_DEBUG` transport tracing, and it was the copy nothing ran —
 * `libi serve-mcp` routes through `lib/cli/index.ts`, never through
 * `mcp/index.ts`). Whatever is added here is now on both surfaces.
 *
 * This is NOT how the in-app agent or a `libi connect`-ed CLI reaches libi:
 * both go through the streamable-HTTP aggregator (`mcp/http/`, `serve-mcp-http`),
 * which is what `libi connect` writes into the user's agent config. Stdio stays
 * because it is the entry an MCP client can be pointed at by hand — an
 * inspector, a client with no HTTP transport, a debugging session — and it is
 * gated on every release (`scripts/local-registry`, `dist-cli/mcp/index.js`).
 *
 * Note what does NOT happen here: no DB migration. The parent (the libi
 * server) owns that. "no such table" from an MCP child means the parent did not
 * migrate before spawning it; in tests, call `migrateDatabase()` against your
 * temp `LIBI_HOME` first. `JobManager` is not here either — it runs in the
 * Next.js process, and MCP-side tools reach it over HTTP through
 * `mcp/jobs-client.ts`.
 */
export async function serveMcp() {
  ensureLibiDirs();

  logger.info("Loading MCP server...");

  const server = createLibiMcpServer();
  const transport = new StdioServerTransport();

  // LIBI_DEBUG=1 enables MCP transport tracing.
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
