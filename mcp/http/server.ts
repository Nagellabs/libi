import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpLogger as logger } from "@/lib/logger";
import { surfaceFromHeaders, type AgentSurface } from "@/lib/mcp/agent-surface";
import { trackCliSessionOpened } from "@/mcp/analytics";
import { renderInstructionsCore } from "@/mcp/workspace";
import { LIBI_SKILL_VERSION } from "@/mcp/version";
import { createAggregateSession, type AggregateSession } from "./session";
import { summarizeSessions } from "./session-summary";

type Dialect = "claude" | "codex";

/** How often the idle sweep runs, and how long a session may sit unused. */
const DEFAULT_IDLE_SWEEP_MS = 60_000;
const DEFAULT_IDLE_MAX_MS = 30 * 60_000;
/** Cap on `close()` waiting for `server.close()` to call back. */
const CLOSE_TIMEOUT_MS = 2_000;
/** Nothing this server accepts a body for is anywhere near this big. */
const MAX_BODY_BYTES = 64 * 1024;

/** Read a millisecond override off the environment; ignore junk. */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  session: AggregateSession;
  lastSeen: number;
  /**
   * Requests currently inside `transport.handleRequest`. A standalone GET
   * keeps one pending for the whole life of its SSE stream, and a slow
   * `tools/call` for the whole life of the call — neither touches `lastSeen`
   * again until it finishes, so the sweep must look at this, not the stamp.
   */
  inFlight: number;
  /** Fixed at `initialize`; `/healthz` counts sessions by these. */
  surface: AgentSurface;
  dialect: Dialect;
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    let settled = false;
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (c: Buffer | string) => {
      if (settled) return;
      raw += c;
      if (raw.length > MAX_BODY_BYTES) {
        // Oversized body: stop reading rather than buffering it all.
        req.pause();
        finish({});
      }
    });
    req.on("end", () => {
      try {
        finish(raw ? JSON.parse(raw) : {});
      } catch {
        finish({});
      }
    });
    // Without these, a client that dies mid-body leaves this promise — and
    // with it the request handler that awaits it — pending forever.
    req.on("error", () => finish({}));
    req.on("aborted", () => finish({}));
  });
}

/**
 * The aggregator: one process, one port, one MCP session per connected
 * agent. Sessions are stateful (SDK `mcp-session-id`); each gets its own
 * aggregate `Server` built for its surface (header) and dialect (`?agent=`).
 * It serves libi's own tools and nothing else. `POST /reload`
 * re-renders the instructions (called by `invalidateMcpConfig` in the Next
 * process).
 *
 * All logging goes through `mcpLogger` → `~/.libi/logs/libi.log`, tag
 * `mcp-http`; this process writes nothing to stdout/stderr of its own.
 */
export async function startMcpHttpServer(opts: {
  port: number;
  host?: string;
  /**
   * Echoed from `/healthz` as `healthToken`. The supervisor that launched this
   * process handed it a token of its own, and only an answer carrying that
   * token proves the socket it polled is this process rather than another libi
   * instance's aggregator on the same port. Left out of the body when unset:
   * `libi serve-mcp-http` run by hand has no supervisor to answer.
   */
  healthToken?: string;
}): Promise<{ close(): Promise<void> }> {
  const host = opts.host ?? "127.0.0.1";
  /**
   * DNS-rebinding defence. The listener is bound to loopback, but that alone
   * proves nothing about the *web*: a page the user merely visits can point an
   * attacker-controlled domain at 127.0.0.1, and every request then arrives on
   * this socket carrying that domain in `Host`. Without this check the page is
   * same-origin with an endpoint that has tool-execution semantics — it could
   * drive every `libi.*` tool.
   *
   * The `Host` header carries the port, so both forms are listed; the bare
   * names cover a request that omits it (default-port style).
   */
  const allowedHosts = [
    `127.0.0.1:${opts.port}`,
    `localhost:${opts.port}`,
    "127.0.0.1",
    "localhost",
  ];
  const hostAllowed = (value: string | undefined): boolean =>
    value !== undefined && allowedHosts.includes(value.toLowerCase());
  // Overridable so a test can watch a sweep happen in seconds instead of half
  // an hour; unset (the shipped case) keeps the defaults.
  const idleSweepMs = envMs("LIBI_MCP_SWEEP_MS", DEFAULT_IDLE_SWEEP_MS);
  const idleMaxMs = envMs("LIBI_MCP_IDLE_MS", DEFAULT_IDLE_MAX_MS);
  const instructions: Record<Dialect, string> = { claude: "", codex: "" };
  /**
   * Whether the test-mode fakes are attached to ACP sessions. The flag lives
   * in the STUDIO process (`lib/mcp-config.ts#testModeFakesEnabled`), which
   * ships it in every `/reload` body; `true` is that flag's own default, so a
   * child that has not been reloaded yet renders the same banner the studio
   * would. Only meaningful under LIBI_TEST_MODE.
   */
  let fakesAttached = true;
  const render = () => {
    for (const d of ["claude", "codex"] as const) {
      try {
        instructions[d] = renderInstructionsCore(d, { fakesAttached });
      } catch (err) {
        logger.error({ err, tag: "mcp-http", op: "instructions_render_failed", dialect: d });
      }
    }
  };
  render();

  const sessions = new Map<string, SessionEntry>();

  /** Tear one session down: its transport, then its aggregate server. */
  const closeEntry = async (entry: SessionEntry): Promise<void> => {
    await entry.transport.close().catch((err) =>
      logger.warn({ err, tag: "mcp-http", op: "transport_close_failed" }),
    );
    await entry.session.close().catch((err) =>
      logger.warn({ err, tag: "mcp-http", op: "session_close_failed" }),
    );
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${opts.port}`);
    try {
      // Before ANY routing: `/reload` and `/healthz` are as reachable from a
      // rebound page as `/mcp` is, and `/reload` has side effects. The SDK
      // transport re-checks this for `/mcp` (see `allowedHosts` below) — this
      // is the check that covers the other two.
      if (!hostAllowed(req.headers.host)) {
        logger.warn({
          tag: "mcp-http",
          op: "host_rejected",
          host: req.headers.host,
          path: url.pathname,
        });
        res
          .writeHead(403, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "forbidden host" }));
        return;
      }
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            version: LIBI_SKILL_VERSION,
            port: opts.port,
            sessions: sessions.size,
            sessionsBy: summarizeSessions(sessions.values()),
            ...(opts.healthToken ? { healthToken: opts.healthToken } : {}),
          }),
        );
        return;
      }
      if (url.pathname === "/reload" && req.method === "POST") {
        const body = (await readJson(req)) as { reason?: string; testModeFakes?: unknown };
        // Only a real boolean moves it: an older studio (or a hand-rolled
        // curl) sends no field, and must not be read as "no fakes".
        if (typeof body.testModeFakes === "boolean") fakesAttached = body.testModeFakes;
        logger.info({
          tag: "mcp-http",
          op: "reload",
          reason: body.reason ?? "unspecified",
          fakesAttached,
        });
        // Re-render the instructions and tell every session its tool list may
        // have changed. This process reads no mcp-config cache (it serves
        // libi's own tools only), so there is nothing to drop here — and never
        // `invalidateMcpConfig` from this process: it would POST /reload
        // straight back to ourselves.
        render();
        for (const s of sessions.values()) {
          s.session.server.sendToolListChanged().catch((err) =>
            logger.debug({ err, tag: "mcp-http", op: "list_changed_notify_failed" }),
          );
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname !== "/mcp") {
        res.writeHead(404).end();
        return;
      }

      const sid = req.headers["mcp-session-id"];
      if (typeof sid === "string") {
        const existing = sessions.get(sid);
        if (!existing) {
          res
            .writeHead(404, { "content-type": "application/json" })
            .end(JSON.stringify({ error: "unknown session" }));
          return;
        }
        existing.lastSeen = Date.now();
        existing.inFlight++;
        try {
          await existing.transport.handleRequest(req, res);
        } finally {
          existing.inFlight--;
          existing.lastSeen = Date.now();
        }
        return;
      }
      // No session id: only an `initialize` POST is legal. The transport
      // itself rejects anything else with a 400 JSON-RPC error, so there is
      // no need to pre-parse the body here.
      if (req.method !== "POST") {
        res.writeHead(400).end("missing mcp-session-id");
        return;
      }

      const surface = surfaceFromHeaders(req.headers);
      const dialect: Dialect = url.searchParams.get("agent") === "codex" ? "codex" : "claude";
      const session = await createAggregateSession({
        surface,
        dialect,
        instructions: instructions[dialect],
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // Belt-and-braces with the handler-level check above: this one also
        // guards the transport's own later requests on the same session.
        enableDnsRebindingProtection: true,
        allowedHosts,
        onsessioninitialized: (id) => {
          // Born with the `initialize` request itself in flight; the `finally`
          // below is what takes it back to 0.
          sessions.set(id, { transport, session, lastSeen: Date.now(), inFlight: 1, surface, dialect });
          logger.info({
            tag: "mcp-http",
            op: "session_open",
            sessionId: id,
            surface,
            dialect,
            sessions: sessions.size,
          });
          // The user's own CLI reached libi — the ground truth behind every
          // connect flow. Reports nothing for an in-app session.
          trackCliSessionOpened(surface, dialect);
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id && sessions.delete(id)) {
          logger.info({ tag: "mcp-http", op: "session_close", sessionId: id, sessions: sessions.size });
          void session.close().catch((err) =>
            logger.warn({ err, tag: "mcp-http", op: "session_close_failed", sessionId: id }),
          );
        }
      };
      await session.server.connect(transport);
      try {
        await transport.handleRequest(req, res);
      } finally {
        const openedId = transport.sessionId;
        const entry = openedId === undefined ? undefined : sessions.get(openedId);
        if (entry) {
          entry.inFlight--;
          entry.lastSeen = Date.now();
        }
      }
      if (transport.sessionId === undefined) {
        // The transport rejected the request — only an `initialize` POST is
        // legal without a session id, and it answered anything else 400 on its
        // own — so `onsessioninitialized` never fired and nothing else will
        // ever close this session. The aggregate server it carries holds an
        // in-process libi `McpServer` and its client, which would otherwise
        // leak for the life of the process. (Constructing it lazily inside
        // `onsessioninitialized` is not an option: `server.connect(transport)`
        // has to happen before `handleRequest`.)
        await transport
          .close()
          .catch((err) => logger.warn({ err, tag: "mcp-http", op: "transport_close_failed" }));
        await session
          .close()
          .catch((err) => logger.warn({ err, tag: "mcp-http", op: "session_close_failed" }));
        logger.info({
          tag: "mcp-http",
          op: "session_discarded",
          method: req.method,
          sessions: sessions.size,
        });
      }
    } catch (err) {
      logger.error({ err, tag: "mcp-http", op: "request_failed", path: url.pathname });
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  // A failed listen (EADDRINUSE — a second aggregator on the port) must
  // reject, not hang.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  // An agent that walks away leaves a live session (and its in-process libi
  // server) behind — sweep anything unused for half an hour.
  const idleTimer = setInterval(() => {
    const cutoff = Date.now() - idleMaxMs;
    for (const [id, entry] of [...sessions]) {
      // An open SSE stream or a long-running tool call is a LIVE session, no
      // matter how stale its stamp — `lastSeen` cannot move until the request
      // it is inside finishes.
      if (entry.inFlight > 0) continue;
      if (entry.lastSeen > cutoff) continue;
      sessions.delete(id);
      logger.info({
        tag: "mcp-http",
        op: "session_idle_close",
        sessionId: id,
        idleMs: Date.now() - entry.lastSeen,
        sessions: sessions.size,
      });
      void closeEntry(entry);
    }
  }, idleSweepMs);
  idleTimer.unref();

  logger.info({ tag: "mcp-http", op: "listen", host, port: opts.port });

  return {
    close: async () => {
      clearInterval(idleTimer);
      const open = [...sessions.values()];
      sessions.clear();
      for (const entry of open) await closeEntry(entry);
      // `server.close()` waits for every socket to go idle, and a standalone
      // GET's SSE socket never does — drop them, then cap the wait anyway so
      // a wedged socket cannot hold shutdown open forever.
      server.closeAllConnections();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        new Promise<boolean>((r) => server.close(() => r(false))),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(true), CLOSE_TIMEOUT_MS);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (timedOut) {
        logger.warn({ tag: "mcp-http", op: "close_timeout", timeoutMs: CLOSE_TIMEOUT_MS });
      }
    },
  };
}
