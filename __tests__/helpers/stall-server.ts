/**
 * Deterministic local HTTP server for download-stall tests (task #54).
 *
 * Simulates the exact production failure — a socket that goes ESTABLISHED
 * and then silent — without depending on the real flaky network:
 *
 *   /stall-mid-body     sends headers + one chunk, then withholds the rest forever
 *   /stall-pre-headers  accepts the connection, never sends headers
 *   /slow-but-steady    trickles chunks slower than a flat timeout would like,
 *                       but always inside the idle window — must SUCCEED
 *   /flaky              stalls on the first request, serves fully from the second
 *   /ok                 serves a small body immediately
 *   /missing            404
 *
 * Plain HTTP on 127.0.0.1 — production code keeps its HTTPS-only transport;
 * tests reach this server either via the injectable `doFetch` or a
 * `global.fetch` shim that rewrites an https:// URL to this origin.
 */
import http from "node:http";
import type { Socket } from "node:net";

export interface StallServer {
  /** e.g. "http://127.0.0.1:49152" */
  origin: string;
  /** Number of requests seen per path. */
  hits: Map<string, number>;
  close: () => Promise<void>;
}

export const STALL_BODY_CHUNK = Buffer.alloc(64 * 1024, 0xab);
export const STALL_TOTAL_BYTES = 1_000_000;
export const OK_BODY = Buffer.from("hello-from-stall-server");

export const SLOW_CHUNK = Buffer.alloc(8 * 1024, 0xcd);
export const SLOW_CHUNK_COUNT = 12;
export const SLOW_CHUNK_INTERVAL_MS = 100;

export async function startStallServer(): Promise<StallServer> {
  const sockets = new Set<Socket>();
  const hits = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setInterval | typeof setTimeout>>();

  const server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const nthHit = hits.get(path)!;

    switch (path) {
      case "/stall-mid-body": {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(STALL_TOTAL_BYTES),
        });
        res.write(STALL_BODY_CHUNK);
        // …and never another byte. The socket stays ESTABLISHED, exactly
        // like the observed ffmpeg first-boot hang.
        break;
      }
      case "/stall-pre-headers": {
        // Accept the connection, never respond.
        break;
      }
      case "/slow-but-steady": {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(SLOW_CHUNK.length * SLOW_CHUNK_COUNT),
        });
        let sent = 0;
        const timer = setInterval(() => {
          if (sent >= SLOW_CHUNK_COUNT) {
            clearInterval(timer);
            timers.delete(timer);
            res.end();
            return;
          }
          res.write(SLOW_CHUNK);
          sent++;
        }, SLOW_CHUNK_INTERVAL_MS);
        timers.add(timer);
        break;
      }
      case "/flaky": {
        if (nthHit === 1) {
          // First attempt: headers + partial body, then silence.
          res.writeHead(200, { "content-length": String(OK_BODY.length) });
          res.write(OK_BODY.subarray(0, 4));
        } else {
          res.writeHead(200, { "content-length": String(OK_BODY.length) });
          res.end(OK_BODY);
        }
        break;
      }
      case "/ok": {
        res.writeHead(200, { "content-length": String(OK_BODY.length) });
        res.end(OK_BODY);
        break;
      }
      default: {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not Found");
      }
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("stall server failed to bind");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearInterval(t as NodeJS.Timeout);
        timers.clear();
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}
