/**
 * Standalone MCP server entry point — libi's tools on stdio.
 *
 * Run it directly: `tsx mcp/index.ts`, or, in an npm install, the compiled
 * `node dist-cli/mcp/index.js`. `buildLibiEntry()` (`lib/mcp-config.ts`) is the
 * spawn spec for exactly that, and resolves between the two.
 *
 * `libi serve-mcp` serves the SAME server, but it does not run this file: the
 * CLI routes through `lib/cli/index.ts`. Both call `serveMcp()`, which is where
 * the implementation lives — this file is only the executable wrapper.
 * It used to hold a second copy, and the copies had drifted.
 *
 * All tool calls execute in-process (direct DB/storage access).
 * Logs are written to ~/.libi/logs/mcp-server.log.
 */

// Import logger first — sets up file logging and crash handlers.
import { mcpLogger as logger } from "@/lib/logger";
import { serveMcp } from "@/lib/cli/serve-mcp";

serveMcp().catch((err) => {
  logger.fatal({ err }, "MCP server failed to start");
  setTimeout(() => process.exit(1), 100);
});
