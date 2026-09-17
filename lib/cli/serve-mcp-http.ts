import { ensureLibiDirs, parseMcpPortEnv, resolveMcpHttpPort } from "@/lib/libi-home";
import { startMcpHttpServer } from "@/mcp/http/server";

/**
 * `libi serve-mcp-http` — the aggregator by hand. Unlike `serve-mcp` (stdio,
 * one agent) this is a long-lived HTTP process every agent shares; the libi
 * lifecycle normally spawns it, so this exists for debugging and for a
 * bring-your-own-CLI setup pointing at a port.
 */
export async function serveMcpHttp(portArg?: string): Promise<void> {
  ensureLibiDirs();
  // A bare `parseInt` sent `--port abc` straight into `listen(NaN)`, which
  // binds an OS-assigned port nothing else can predict. Reject it instead.
  const port = portArg === undefined ? resolveMcpHttpPort() : parseMcpPortEnv(portArg);
  if (port === null) {
    process.stderr.write(`[libi] invalid --port: ${portArg} (expected 1-65535)\n`);
    process.exit(1);
  }
  await startMcpHttpServer({ port });
  process.stdout.write(`[libi] MCP aggregator listening on http://127.0.0.1:${port}/mcp\n`);
}
