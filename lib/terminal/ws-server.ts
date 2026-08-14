import { WebSocketServer } from "ws";
import { serverLogger as logger } from "@/lib/logger";
import { getCurrentPort } from "@/lib/libi-home";
import { isLoopbackHost } from "@/lib/security/request-guard";
import {
  PORT_RANGE_SIZE,
  PORT_RANGE_START,
  terminalWsPortForNextPort,
} from "@/lib/dev/worktree-bootstrap";
import { getTerminalManager } from "./instance";

/**
 * Dedicated WebSocket server for terminal I/O.
 *
 * Next.js App Router route handlers cannot upgrade WebSockets (no
 * `UPGRADE` export in core Next; `next-ws` monkey-patches Next internals
 * — rejected). Instead a `ws` server binds a loopback port in the SAME
 * process as the PTYs, started lazily on first terminal use. Clients
 * discover the port via GET /api/terminal/ws-info and connect to
 * `ws://127.0.0.1:<port>/?session=<id>`.
 *
 * Port selection mirrors the worktree CDP-port convention: dev worktrees
 * run their Next server on a deterministic port in the dev range, and the
 * terminal ws port is derived 1:1 from it (`terminalWsPortForNextPort`)
 * so multiple worktrees can run terminals side-by-side on stable,
 * distinct ports. Outside the dev range (packaged production uses a
 * random Next port) we bind ephemeral. Determinism is a dev nicety only —
 * the client always discovers the actual port via ws-info, so a collision
 * fallback to ephemeral is always safe.
 *
 * Security: loopback-only bind — the same local-trust model as the Next
 * server itself.
 */
const g = globalThis as unknown as {
  __libiTerminalWs?: { port: Promise<number>; server?: WebSocketServer };
};

/**
 * Pure port resolution: env override → worktree-derived (when the Next
 * port is inside the dev range) → 0 (ephemeral).
 */
export function resolveTerminalWsPort(
  env: Record<string, string | undefined>,
  nextPort: number | null,
): number {
  const override = Number(env.LIBI_TERMINAL_WS_PORT);
  if (Number.isInteger(override) && override > 0) return override;
  if (
    nextPort !== null &&
    nextPort >= PORT_RANGE_START &&
    nextPort < PORT_RANGE_START + PORT_RANGE_SIZE
  ) {
    return terminalWsPortForNextPort(nextPort);
  }
  return 0;
}

function bindServer(
  port: number,
): { server: WebSocketServer; bound: Promise<number> } {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port,
    verifyClient: verifyWsClient,
    // Cap inbound frame size well below the 100 MiB `ws` default — terminal
    // control frames are tiny (keystrokes/pastes/resize). A larger frame is
    // rejected at the protocol layer before it ever reaches handleClientMessage.
    maxPayload: 1024 * 1024,
  });
  const bound = new Promise<number>((resolve, reject) => {
    server.once("listening", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("terminal ws server has no bound port"));
        return;
      }
      resolve(addr.port);
    });
    server.once("error", reject);
  });
  return { server, bound };
}

/**
 * Origin gate for the terminal WebSocket upgrade.
 *
 * The `ws` server handles the HTTP upgrade directly, so the Next.js CSRF
 * middleware (RC-A, Task 1) never sees it — this is the equivalent guard for
 * the loopback PTY transport, closing the DNS-rebinding hijack vector.
 *
 * Semantics:
 * - A missing Origin (a non-browser CLI client, e.g. the ws-info probe) is
 *   allowed — browsers always send an Origin on WebSocket handshakes.
 * - An Origin whose host is loopback (any port — same-machine trust) is
 *   allowed, matching the loopback-only bind of this server.
 * - Any other Origin (a real cross-origin browser page, incl. a rebound
 *   hostname) is rejected.
 *
 * The decision is loopback-host based only (a cross-port loopback page is
 * still same-machine), so no port is needed.
 */
export function isAllowedWsOrigin(origin: string | null): boolean {
  if (origin === null) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return isLoopbackHost(host);
}

/**
 * `ws` `verifyClient` hook — runs during the HTTP upgrade, BEFORE the 101
 * handshake completes. Rejecting here makes `ws` abort with HTTP 401 and no
 * `connection` event ever fires, so a cross-origin client never gets a live
 * socket. `info.origin` is the request's Origin header (absent → undefined).
 */
function verifyWsClient(info: { origin?: string }): boolean {
  const origin = info.origin ?? null;
  if (isAllowedWsOrigin(origin)) return true;
  logger.warn(
    { tag: "terminal", op: "ws_origin_reject", origin },
    "rejected cross-origin terminal WS upgrade",
  );
  return false;
}

function wireConnections(server: WebSocketServer): void {
  server.on("connection", (socket, request) => {
    // Cross-origin rejection happens pre-handshake in `verifyWsClient`
    // (the ws `verifyClient` hook), so any socket that reaches here has
    // already passed the Origin gate.
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const sessionId = url.searchParams.get("session");
    if (!sessionId) {
      socket.close(4400, "missing session parameter");
      return;
    }
    // attach() closes the socket with 4404 itself when the id is unknown.
    void getTerminalManager()
      .attach(sessionId, socket)
      .catch((err) => {
        logger.error(
          { tag: "terminal", op: "attach_failed", sessionId, err },
          "terminal attach threw",
        );
        try {
          socket.close(1011, "attach failed");
        } catch {
          // already closed
        }
      });
  });
}

export function ensureTerminalWsServer(): Promise<number> {
  if (g.__libiTerminalWs) return g.__libiTerminalWs.port;

  const entry: { port?: Promise<number>; server?: WebSocketServer } = {};
  entry.port = (async () => {
      let nextPort: number | null = null;
      try {
        nextPort = getCurrentPort();
      } catch {
        nextPort = null;
      }
      const preferred = resolveTerminalWsPort(process.env, nextPort);

      let server: WebSocketServer;
      let boundPort: number;
      try {
        const first = bindServer(preferred);
        boundPort = await first.bound;
        server = first.server;
      } catch (err) {
        if (preferred === 0) {
          delete g.__libiTerminalWs;
          logger.error(
            { tag: "terminal", op: "ws_listen_failed", err },
            "terminal WebSocket server failed to bind",
          );
          throw err;
        }
        // Deterministic port taken (another process squatting, stale
        // server) — fall back to ephemeral. ws-info discovery keeps
        // clients correct either way.
        logger.warn(
          { tag: "terminal", op: "ws_bind_fallback", preferred, err },
          "terminal ws port taken; falling back to an ephemeral port",
        );
        try {
          const retry = bindServer(0);
          boundPort = await retry.bound;
          server = retry.server;
        } catch (err2) {
          delete g.__libiTerminalWs;
          logger.error(
            { tag: "terminal", op: "ws_listen_failed", err: err2 },
            "terminal WebSocket server failed to bind",
          );
          throw err2;
        }
      }

      wireConnections(server);
      entry.server = server;
      logger.info(
        { tag: "terminal", op: "ws_listen", port: boundPort, preferred },
        "terminal WebSocket server listening",
      );
      return boundPort;
  })();

  g.__libiTerminalWs = entry as { port: Promise<number>; server?: WebSocketServer };
  return entry.port;
}
