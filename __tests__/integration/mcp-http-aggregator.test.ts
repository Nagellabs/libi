import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrateDatabase, getDb, resetDbClient } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { startMcpHttpChild } from "@/lib/server/lifecycle/mcp-http-child";
import {
  spawnMcpHttpChild,
  waitFor,
  findDescendantPid,
  freePort,
  type SpawnedMcpHttpChild,
} from "@/__tests__/helpers/mcp-http-child";

/**
 * Assigned in `beforeAll` from a real `listen(0)` probe. A random number in a
 * 90-wide range collided often enough to be a flake with no connection to what
 * the failing test was checking.
 */
let PORT: number;
let home: string;
let child: SpawnedMcpHttpChild;
let prevHome: string | undefined;

const JSON_RPC_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

/** Open a session with a raw POST — no SDK client, so no standalone GET stream. */
async function rawInitialize(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: JSON_RPC_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw-it", version: "0" },
      },
    }),
  });
  const sid = res.headers.get("mcp-session-id");
  await res.text(); // drain the SSE response so the request completes server-side
  if (!sid) throw new Error(`initialize returned no session id (status ${res.status})`);
  return sid;
}

async function sessionCount(baseUrl: string): Promise<number> {
  return ((await (await fetch(`${baseUrl}/healthz`)).json()) as { sessions: number }).sessions;
}

/**
 * Count `op` lines the child has logged. The child runs under this test's
 * LIBI_HOME, so its structured log is `<home>/logs/libi.log`; the destination
 * is async, hence the short retry.
 */
async function countLoggedOps(op: string, atLeast: number): Promise<number> {
  const logPath = path.join(home, "logs", "libi.log");
  const deadline = Date.now() + 5_000;
  let seen = 0;
  do {
    seen = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").split("\n").filter((l) => l.includes(`"op":"${op}"`)).length
      : 0;
    if (seen >= atLeast) return seen;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);
  return seen;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = http.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function connect(headers: Record<string, string> = {}, agent = "claude") {
  const client = new Client({ name: "it", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${child.baseUrl}/mcp?agent=${agent}`), {
    requestInit: { headers },
  });
  await client.connect(transport);
  return { client, transport };
}

/**
 * Issue a request with an explicit `Host` header. `fetch` cannot do this —
 * undici treats `Host` as a forbidden header and silently drops it — so a
 * DNS-rebinding attempt has to be spelled out at the socket level, which is
 * exactly what the attack looks like on the wire anyway.
 */
function requestWithHost(
  port: number,
  requestPath: string,
  hostHeader: string,
  method = "GET",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: requestPath, method, headers: { host: hostHeader } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("HTTP MCP aggregator (real child, libi's tools only)", () => {
  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-mcp-http-"));
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = home;
    resetDbClient();
    migrateDatabase();
    // An upgraded install carries a leftover `youtube-downloader` row (the
    // def became the youtube-download extension; its DB row is dropped by a
    // later migration). The aggregator used to connect every enabled row at
    // boot — this is the row that spawned `npx -y @kevinwatt/yt-dlp-mcp` on
    // every launch — so it is seeded here, "installed" and "up", to prove
    // it is now simply ignored: nothing spawned, nothing advertised.
    const staleRow = {
      id: "youtube-downloader",
      name: "YouTube Downloader",
      description: "leftover from an older install",
      type: "stdio",
      command: "npx",
      args: JSON.stringify(["-y", "@kevinwatt/yt-dlp-mcp@0.9.0"]),
      url: null,
      headers: null,
      envVars: "{}",
      bundled: true,
      requireApproval: false,
      installStatus: "installed",
      serverStatus: "up",
      dependencyStatus: "[]",
    } as const;
    getDb()
      .insert(mcpServers)
      .values(staleRow)
      .onConflictDoUpdate({ target: mcpServers.id, set: staleRow })
      .run();
    PORT = await freePort();
    child = await spawnMcpHttpChild({ libiHome: home, port: PORT });
  }, 60_000);

  afterAll(async () => {
    await child?.kill();
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    resetDbClient();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("healthz reports libi's own endpoint and nothing about upstreams", async () => {
    const body = (await (await fetch(`${child.baseUrl}/healthz`)).json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(body.port).toBe(PORT);
    expect(typeof body.sessions).toBe("number");
    expect(body).not.toHaveProperty("upstreams");
    expect(body).not.toHaveProperty("upstreamsReady");
    expect(Object.keys(body).sort()).toEqual(["ok", "port", "sessions", "sessionsBy", "version"]);
    expect(body.sessionsBy).toEqual({ inApp: { claude: 0, codex: 0 }, cli: { claude: 0, codex: 0 } });

    const c = await connect({ "x-libi-surface": "in-app" });
    try {
      const withOne = (await (await fetch(`${child.baseUrl}/healthz`)).json()) as Record<string, unknown>;
      expect(withOne.sessionsBy).toEqual({ inApp: { claude: 1, codex: 0 }, cli: { claude: 0, codex: 0 } });
    } finally {
      await c.client.close();
    }
  });

  it("healthz echoes the token a supervisor launched it with", async () => {
    // The shared child above was launched without one, and its body has no
    // `healthToken` key (the exact key list). A supervised launch gets one, and
    // only its echo proves the answer came from that child.
    const token = "0123456789abcdef0123456789abcdef";
    const supervised = await spawnMcpHttpChild({
      libiHome: home,
      port: await freePort(),
      env: { LIBI_MCP_HEALTH_TOKEN: token },
      // A supervisor always hands its child a stdin pipe; at /dev/null a
      // supervised child reads end-of-file at once and shuts down.
      stdin: "pipe",
    });
    try {
      const body = (await (await fetch(`${supervised.baseUrl}/healthz`)).json()) as Record<string, unknown>;
      expect(body.healthToken).toBe(token);
      expect(body.ok).toBe(true);
    } finally {
      await supervised.kill();
    }
  });

  it("a supervised aggregator exits and frees its port when its stdin closes, as it does when the libi server that launched it dies", async () => {
    // The supervisor holds the only write end of this pipe, so its death by
    // any means (a SIGKILL, a closed terminal) arrives here as end-of-file.
    const port = await freePort();
    const supervised = await spawnMcpHttpChild({
      libiHome: home,
      port,
      env: { LIBI_MCP_HEALTH_TOKEN: "fedcba9876543210fedcba9876543210" },
      stdin: "pipe",
    });
    // The aggregator is tsx's grandchild, and the pipe has to reach it.
    const server = findDescendantPid(supervised.pid, "mcp/http/index.ts");
    try {
      expect(server).not.toBeNull();
      supervised.closeStdin();
      await waitFor(() => supervised.exited(), { timeoutMs: 10_000, message: "the wrapper to exit" });
      await waitFor(
        () => {
          try {
            process.kill(server!, 0);
            return false;
          } catch {
            return true;
          }
        },
        { timeoutMs: 10_000, message: "the aggregator process to exit" },
      );
      await waitFor(
        () =>
          new Promise<boolean>((resolve) => {
            const probe = http.createServer();
            probe.once("error", () => resolve(false));
            probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
          }),
        { timeoutMs: 5_000, message: "the port to be free again" },
      );
      expect(await countLoggedOps("supervisor_gone", 1)).toBeGreaterThanOrEqual(1);
    } finally {
      await supervised.kill();
    }
  }, 60_000);

  it("a supervised aggregator leaves Ctrl-C to libi and still exits on libi's SIGTERM", async () => {
    // Under npx the child shares the terminal's group, so a Ctrl-C reaches it
    // directly. Exiting on it would race libi's own stop and read as a crash.
    const port = await freePort();
    const supervised = await spawnMcpHttpChild({
      libiHome: home,
      port,
      env: { LIBI_MCP_HEALTH_TOKEN: "00112233445566778899aabbccddeeff" },
      stdin: "pipe",
    });
    // Signal the aggregator itself, not tsx's wrapper: under npx there is no
    // wrapper in between.
    const server = findDescendantPid(supervised.pid, "mcp/http/index.ts");
    try {
      expect(server).not.toBeNull();
      const ignoredBefore = await countLoggedOps("sigint_ignored", 0);
      process.kill(server!, "SIGINT");
      expect(await countLoggedOps("sigint_ignored", ignoredBefore + 1)).toBe(ignoredBefore + 1);
      process.kill(server!, 0); // still alive
      expect(((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { ok: boolean }).ok).toBe(true);

      process.kill(server!, "SIGTERM");
      await waitFor(() => !isAlive(server!), { timeoutMs: 10_000, message: "the aggregator to exit on SIGTERM" });
      await waitFor(() => portIsFree(port), { timeoutMs: 5_000, message: "the port to be free again" });
    } finally {
      await supervised.kill();
    }
  }, 60_000);

  it("an aggregator run by hand still exits on Ctrl-C", async () => {
    const port = await freePort();
    const byHand = await spawnMcpHttpChild({ libiHome: home, port });
    const server = findDescendantPid(byHand.pid, "mcp/http/index.ts");
    try {
      expect(server).not.toBeNull();
      process.kill(server!, "SIGINT");
      await waitFor(() => !isAlive(server!), { timeoutMs: 10_000, message: "the aggregator to exit on SIGINT" });
      await waitFor(() => portIsFree(port), { timeoutMs: 5_000, message: "the port to be free again" });
    } finally {
      await byHand.kill();
    }
  }, 60_000);

  it("a supervised launch on a pinned port another process holds gives up as soon as the endpoint exits, and the report quotes the cause it printed", async () => {
    // What holds the port accepts connections and never answers, so no
    // /healthz attempt ever says why the endpoint is not coming up. Only the
    // endpoint's own last words can.
    const held = new Set<net.Socket>();
    const blocker = net.createServer((socket) => {
      held.add(socket);
      socket.on("close", () => held.delete(socket));
    });
    const port = await freePort();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    const token = "feedfacefeedfacefeedfacefeedface";
    const portFile = path.join(home, "mcp-port-pinned");
    const onGaveUp = vi.fn();
    const started = Date.now();
    const handle = await startMcpHttpChild({
      portFile,
      // A pinned LIBI_MCP_PORT: every pick is the same port.
      pickPort: async () => port,
      isFree: async () => false,
      healthToken: () => token,
      onGaveUp,
    });
    try {
      expect(handle.status()).toBe("gave-up");
      // Well inside the first launch's 30 s window.
      expect(Date.now() - started).toBeLessThan(25_000);
      expect(onGaveUp).toHaveBeenCalledTimes(1);
      const message = (onGaveUp.mock.calls[0][0] as Error).message;
      expect(message).toMatch(/exited before becoming healthy/);
      expect(message).toMatch(/\[libi mcp-http\] failed to start: EADDRINUSE /);
      expect(message).not.toContain(token);
      expect(fs.existsSync(portFile)).toBe(false);
    } finally {
      await handle.stop();
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  }, 60_000);

  it("an aggregator run by hand ignores its stdin: the shared child has served every test above with stdin at /dev/null", async () => {
    // /dev/null reads end-of-file at once, as a closed pipe does, and this
    // child carries no token, so it is not watching. (The log is shared with
    // the supervised children above, which did shut down on purpose.)
    expect(child.exited()).toBe(false);
    const body = (await (await fetch(`${child.baseUrl}/healthz`)).json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it("initialize carries the instructions, tools/list is libi-only, cli surface hides show_in_chat", async () => {
    const { client: c } = await connect();
    expect(c.getInstructions()).toContain("libi.read_manual");
    expect(c.getInstructions()!.length).toBeLessThan(2048);
    // `read_manual` is sectioned: no argument returns the index + essentials
    // (< 15 KB), not the ~87 KB manual a client would spool to disk.
    const index = await c.callTool({ name: "libi.read_manual", arguments: {} });
    const indexText = (index.content as Array<{ type: string; text: string }>)[0].text;
    expect(indexText).toContain("`mcp-tools`");
    expect(indexText).toContain('libi.read_manual({ section: "<key>" })');
    expect(Buffer.byteLength(indexText, "utf8")).toBeLessThan(15_000);
    const manual = await c.callTool({
      name: "libi.read_manual",
      arguments: { section: "mcp-tools" },
    });
    expect((manual.content as Array<{ type: string; text: string }>)[0].text).toContain("## MCP Tools");
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("libi.list_pieces");
    expect(names.length).toBeGreaterThan(10);
    expect(names.every((n) => n.startsWith("libi."))).toBe(true);
    expect(names).not.toContain("libi.show_in_chat");
    await c.close();
  });

  it("in-app header exposes libi.show_in_chat", async () => {
    const { client: c } = await connect({ "x-libi-surface": "in-app" });
    expect((await c.listTools()).tools.map((t) => t.name)).toContain("libi.show_in_chat");
    await c.close();
  });

  it("calls a libi tool through the session", async () => {
    const { client: c } = await connect();
    const pieces = await c.callTool({ name: "libi.list_pieces", arguments: {} });
    expect(pieces.isError ?? false).toBe(false);
    expect(Array.isArray(pieces.content) && pieces.content.length > 0).toBe(true);
    await c.close();
  });

  it("a stale third-party MCP row spawns nothing and advertises nothing", async () => {
    // The row is "installed" and "up" — everything the old upstream
    // filter used to wave through. Nothing under this aggregator may be
    // running its command, and no tool of its may be on the list.
    expect(findDescendantPid(child.pid, "yt-dlp-mcp")).toBeNull();
    const { client: c } = await connect();
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names.every((n) => n.startsWith("libi."))).toBe(true);
    await c.close();
    // …and the aggregator never even tried: the spawn op the old manager
    // logged for every upstream is gone from this child's log. `atLeast: 0`
    // makes this a single read — polling for an absence would only wait out
    // the deadline.
    expect(await countLoggedOps("upstream_spawn", 0)).toBe(0);
  });

  it("DELETE closes the session", async () => {
    const before = ((await (await fetch(`${child.baseUrl}/healthz`)).json()) as { sessions: number }).sessions;
    const { client: c, transport } = await connect();
    // `Client#close()` does not send the MCP session DELETE, so the server
    // session would stay resident until the idle sweep. Terminate the
    // session explicitly so `sessions` reflects it going away immediately.
    await transport.terminateSession();
    await c.close();
    await waitFor(async () => (await sessionCount(child.baseUrl)) === before, {
      message: `session count returning to ${before} after DELETE`,
    });
    const after = await sessionCount(child.baseUrl);
    expect(after).toBe(before);
  });

  it("a non-initialize POST without a session id is rejected and leaves no session behind", async () => {
    const before = await sessionCount(child.baseUrl);
    // Each of these builds an aggregate session (server.connect must precede
    // handleRequest) that the transport then refuses to adopt. If the server
    // does not discard it, its in-process libi McpServer lives forever —
    // invisible in `sessions`.
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${child.baseUrl}/mcp`, {
        method: "POST",
        headers: JSON_RPC_HEADERS,
        body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/list" }),
      });
      expect(res.status).toBe(400);
      await res.text();
    }
    expect(await sessionCount(child.baseUrl)).toBe(before);
    // The count above cannot see a leak — a rejected session was never in the
    // map. The log line is the only evidence the server actually tore each
    // one down.
    expect(await countLoggedOps("session_discarded", 3)).toBe(3);

    // A real session + /reload still works afterwards: the endpoint survives
    // an instructions re-render and keeps serving.
    const { client: c, transport } = await connect();
    const reload = await fetch(`${child.baseUrl}/reload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "after-discard" }),
    });
    expect(reload.status).toBe(200);
    expect((await reload.json()) as { ok: boolean }).toEqual({ ok: true });
    expect((await c.listTools()).tools.map((t) => t.name)).toContain("libi.list_pieces");
    await transport.terminateSession();
    await c.close();
  });

  it("rejects a rebound Host on every path, and still serves the real one", async () => {
    // DNS rebinding: a page the user merely visits resolves an
    // attacker-controlled name to 127.0.0.1, so the request arrives here with
    // that name in `Host` and the page is same-origin with a tool-execution
    // endpoint. /reload and /healthz are as reachable as /mcp, and /reload has
    // side effects — so the check runs before ANY routing.
    for (const [p, method] of [
      ["/healthz", "GET"],
      ["/reload", "POST"],
      ["/mcp", "POST"],
    ] as const) {
      const res = await requestWithHost(PORT, p, "evil.example:80", method);
      expect({ p, status: res.status }).toEqual({ p, status: 403 });
      expect(JSON.parse(res.body)).toEqual({ error: "forbidden host" });
    }
    expect(await countLoggedOps("host_rejected", 3)).toBeGreaterThanOrEqual(3);

    // The loopback names the SDK client and the lifecycle actually use are
    // untouched — every other case in this file goes through them.
    for (const h of [`127.0.0.1:${PORT}`, `localhost:${PORT}`]) {
      const ok = await requestWithHost(PORT, "/healthz", h);
      expect({ h, status: ok.status }).toEqual({ h, status: 200 });
      expect((JSON.parse(ok.body) as { ok: boolean }).ok).toBe(true);
    }
  });

  it("the idle sweep reaps an unused session but spares one holding an open stream", async () => {
    const port2 = await freePort();
    const child2 = await spawnMcpHttpChild({
      libiHome: home,
      port: port2,
      env: { LIBI_MCP_IDLE_MS: "500", LIBI_MCP_SWEEP_MS: "100" },
    });
    const abort = new AbortController();
    try {
      const idleSid = await rawInitialize(child2.baseUrl);
      const liveSid = await rawInitialize(child2.baseUrl);
      expect(await sessionCount(child2.baseUrl)).toBe(2);

      // Standalone GET: the server's handleRequest stays pending for the life
      // of this SSE stream, so `lastSeen` cannot advance. Leave the body
      // unconsumed — it is the open socket that matters.
      const stream = await fetch(`${child2.baseUrl}/mcp`, {
        headers: { accept: "text/event-stream", "mcp-session-id": liveSid },
        signal: abort.signal,
      });
      expect(stream.status).toBe(200);

      // The idle sweep needs a poll, not a flat wait: proving the live session
      // is spared is proving the ABSENCE of an event, so it stays a bounded
      // wait (<=1.5s) rather than something with its own success predicate.
      await waitFor(async () => (await sessionCount(child2.baseUrl)) === 1, {
        timeoutMs: 1_500,
        message: "idle session reaped (sessions === 1)",
      });

      expect(await sessionCount(child2.baseUrl)).toBe(1);
      // …and the survivor is the streaming one: the idle id is gone, the live
      // id still answers.
      const gone = await fetch(`${child2.baseUrl}/mcp`, {
        method: "POST",
        headers: { ...JSON_RPC_HEADERS, "mcp-session-id": idleSid },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      expect(gone.status).toBe(404);
      await gone.text();
      const alive = await fetch(`${child2.baseUrl}/mcp`, {
        method: "POST",
        headers: { ...JSON_RPC_HEADERS, "mcp-session-id": liveSid },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
      });
      expect(alive.status).toBe(200);
      expect(await alive.text()).toContain("libi.list_pieces");
    } finally {
      abort.abort();
      await child2.kill();
    }
  }, 60_000);
});
