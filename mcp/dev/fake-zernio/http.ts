import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpLogger as logger } from "@/lib/logger";
import { createFakeZernioMcpServer } from "./server";
import { createFakeState, type FakeState } from "./state";
import { loadScenarioConfig } from "./config";

export interface FakeZernioHttp {
  /** The `/mcp` endpoint — what `connectProviderMcp` and the ACP entry use. */
  url: string;
  /** `http://127.0.0.1:<port>` — the presigned media host. */
  baseUrl: string;
  state: FakeState;
  close(): Promise<void>;
}

/**
 * Start the fake over streamable HTTP.
 *
 * **Why HTTP and not stdio like fake-fal.** The agent and libi's own dashboard
 * client must observe ONE state: a draft the agent creates has to show up in
 * the piece's Posting tab. A stdio fake spawned per ACP session would be a
 * separate process with separate memory, so the two would never agree. This
 * one runs in the studio process, the ACP entry points at it
 * (`{ type: "http", name: "zernio", url }`), and the social service connects
 * to the same URL through `LIBI_SOCIAL_MCP_URL`.
 *
 * It also serves `PUT /media/<key>` and `GET /media/<key>` — the presigned
 * upload target, so the upload job really transfers bytes instead of being
 * stubbed out.
 *
 * Loopback only, and no `Host` check: unlike libi's own aggregator
 * (`mcp/http/server.ts`) this endpoint is never reachable off-loopback and
 * only exists in test mode.
 */
export async function startFakeZernioHttp(opts: { port?: number; state?: FakeState } = {}): Promise<FakeZernioHttp> {
  const state = opts.state ?? createFakeState(loadScenarioConfig());
  let baseUrl = "";
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const srv = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      logger.warn({ err, tag: "fake-zernio", op: "request_failed", url: req.url }, "fake zernio request failed");
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", baseUrl || "http://127.0.0.1");
    if (url.pathname.startsWith("/media/")) return media(req, res, decodeURIComponent(url.pathname.slice("/media/".length)));
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, fake: "zernio", posts: state.posts.size, sessions: transports.size }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        transports.set(id, transport);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) transports.delete(id);
    };
    await createFakeZernioMcpServer(state, baseUrl).connect(transport);
    await transport.handleRequest(req, res);
  }

  function media(req: http.IncomingMessage, res: http.ServerResponse, key: string): Promise<void> {
    return new Promise((resolve) => {
      if (req.method === "PUT" || req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          state.uploads.set(key, Buffer.concat(chunks));
          res.writeHead(200, { etag: `"${key}"` }).end();
          resolve();
        });
        return;
      }
      const body = state.uploads.get(key);
      if (!body) {
        res.writeHead(404).end();
        resolve();
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.byteLength) });
      if (req.method === "HEAD") res.end();
      else res.end(body);
      resolve();
    });
  }

  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  const address = srv.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  logger.info({ tag: "fake-zernio", op: "listen", url: `${baseUrl}/mcp` }, "fake zernio MCP listening (test mode)");

  return {
    url: `${baseUrl}/mcp`,
    baseUrl,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        for (const transport of transports.values()) void transport.close().catch(() => {});
        transports.clear();
        srv.close(() => resolve());
        srv.closeAllConnections?.();
      }),
  };
}
