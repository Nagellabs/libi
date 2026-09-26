/**
 * A standalone launcher for the fake, for `npx @modelcontextprotocol/inspector`
 * parity: it starts the same HTTP listener the studio starts in test mode and
 * prints its URL.
 *
 * It is NOT how test mode wires the fake — that goes through
 * `lib/social/test-fake.ts`, in the studio process, so the agent and libi's own
 * client share one state. A hand-run listener here has a state of its own.
 */
import { ensureLibiDirs } from "@/lib/libi-home";
import { mcpLogger as logger } from "@/lib/logger";
import { startFakeZernioHttp } from "@/mcp/dev/fake-zernio/http";

async function main(): Promise<void> {
  ensureLibiDirs();
  const fake = await startFakeZernioHttp({ port: Number(process.env.LIBI_FAKE_ZERNIO_PORT ?? 0) });
  logger.info({ tag: "fake-zernio", op: "standalone", url: fake.url }, "fake zernio MCP running (standalone)");
  process.stdout.write(`${fake.url}\n`);
}

main().catch((err) => {
  logger.fatal({ err, tag: "fake-zernio", op: "start_failed" }, "fake zernio MCP failed to start");
  setTimeout(() => process.exit(1), 100);
});
