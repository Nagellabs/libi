/**
 * /api/mcp/health — the Settings card's window into the aggregator.
 *
 * The route is a proxy with one addition that matters: the PARENT's view of
 * the child (`childStatus`). The aggregator's own `/healthz` cannot report
 * "gave-up" — a process that has stopped restarting answers nothing at all —
 * so a UI reading only the upstream health would show the endpoint as merely
 * "unreachable" when the truth is that the lifecycle has given up on it.
 *
 * The port is this instance's own, and while this instance's child is not
 * running nothing is proxied: whatever answers on that port then may be
 * another libi instance's aggregator, and its version and sessions would be
 * shown as ours.
 *
 * `url` feeds the Agents page's `mcp add` commands, so while the child is not
 * running it names the port the registration check judges against.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpHttpChildHandle } from "@/lib/server/lifecycle/mcp-http-child";
import { DEFAULT_MCP_PORT } from "@/lib/libi-home";

// The mcp-port file and the default: what a guess would name. The tests below
// show the route never uses it while a supervisor exists. The real resolver
// (the `LIBI_MCP_PORT` pin, else the default) stays.
vi.mock("@/lib/libi-home", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/libi-home")>()),
  getCurrentMcpPort: () => 3457,
}));

const { setMcpHttpChild } = await import("@/lib/server/lifecycle/mcp-http-handle");
const { GET } = await import("@/app/api/mcp/health/route");

/** The token this instance's current child was launched with. */
const OWN_TOKEN = "0123456789abcdef0123456789abcdef";

function handle(
  status: McpHttpChildHandle["status"] extends () => infer S ? S : never,
  over: Partial<McpHttpChildHandle> = {},
): McpHttpChildHandle {
  return {
    port: 41234,
    advertisedPort: 41234,
    publishedPort: 41234,
    stop: async () => {},
    restart: async () => {},
    status: () => status,
    ownsHealthAnswer: (body) => (body as { healthToken?: unknown } | null)?.healthToken === OWN_TOKEN,
    ...over,
  };
}

/** A first launch that moved off a busy default to 3501 and never published a port. */
const NOTHING_PUBLISHED = { port: 3501, advertisedPort: 3501, publishedPort: null } as const;

describe("GET /api/mcp/health", () => {
  let prevPin: string | undefined;

  beforeEach(() => {
    prevPin = process.env.LIBI_MCP_PORT;
    delete process.env.LIBI_MCP_PORT;
    setMcpHttpChild(handle("running"));
  });

  afterEach(() => {
    setMcpHttpChild(null);
    vi.unstubAllGlobals();
    if (prevPin === undefined) delete process.env.LIBI_MCP_PORT;
    else process.env.LIBI_MCP_PORT = prevPin;
  });

  it("merges the aggregator's /healthz body and adds url + childStatus, without the supervisor's token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          version: "1.2.3",
          port: 41234,
          sessions: 2,
          healthToken: OWN_TOKEN,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:41234/healthz",
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(body.ok).toBe(true);
    expect(body.url).toBe("http://127.0.0.1:41234/mcp");
    expect(body.childStatus).toBe("running");
    expect(body.version).toBe("1.2.3");
    expect(body.port).toBe(41234);
    expect(body.sessions).toBe(2);
    expect(body).not.toHaveProperty("healthToken");
    // The aggregator proxies nothing, so there is no upstream
    // list to forward — and the route must not invent one.
    expect(body).not.toHaveProperty("upstreams");
    expect(body).not.toHaveProperty("upstreamsReady");
  });

  it("answers 503 with the error when a running child does not respond", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:41234");
      }),
    );

    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.error).toContain("ECONNREFUSED");
    expect(body.url).toBe("http://127.0.0.1:41234/mcp");
    expect(body.childStatus).toBe("running");
  });

  it("proxies nothing while this instance's child is not running, and still names this instance's own endpoint", async () => {
    // Another instance's aggregator would answer 200 on the guessed port.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, version: "other" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    for (const status of ["gave-up", "restarting", "stopped"] as const) {
      setMcpHttpChild(handle(status));
      const res = await GET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.childStatus).toBe(status);
      // Enough for the UI to name the endpoint and tell the states apart.
      expect(body.url).toBe("http://127.0.0.1:41234/mcp");
      expect(body.error).toMatch(/not running/);
      expect(body).not.toHaveProperty("version");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies nothing a running child did not answer itself: a crash relaunch's port may already be another instance's", async () => {
    for (const foreign of [
      { ok: true, version: "other", sessions: 7 },
      { ok: true, version: "other", sessions: 7, healthToken: "fedcba9876543210fedcba9876543210" },
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(foreign), { status: 200 })));
      const res = await GET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.childStatus).toBe("running");
      expect(body.url).toBe("http://127.0.0.1:41234/mcp");
      expect(body.error).toBe("another process answered on this port");
      expect(body).not.toHaveProperty("version");
      expect(body).not.toHaveProperty("sessions");
      expect(body).not.toHaveProperty("healthToken");
    }
  });

  it("after a first launch gave up with nothing published, names the default port a registration is judged against, not the dead fallback", async () => {
    // A Connect built from the fallback would write a port the registration
    // check calls stale at once, and that a restart moves away from.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    for (const status of ["gave-up", "restarting"] as const) {
      setMcpHttpChild(handle(status, NOTHING_PUBLISHED));
      const res = await GET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.childStatus).toBe(status);
      expect(body.url).toBe(`http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("after a first launch gave up with nothing published, names the LIBI_MCP_PORT pin when one is set", async () => {
    process.env.LIBI_MCP_PORT = "4555";
    setMcpHttpChild(handle("gave-up", NOTHING_PUBLISHED));
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).url).toBe("http://127.0.0.1:4555/mcp");
  });

  it("while running, names and probes the live port even when nothing is published yet and a pin names another", async () => {
    process.env.LIBI_MCP_PORT = "4555";
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, port: 3501, healthToken: OWN_TOKEN }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    setMcpHttpChild(handle("running", NOTHING_PUBLISHED));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe("http://127.0.0.1:3501/mcp");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3501/healthz", expect.anything());
  });

  it("reports childStatus 'unknown' when there is no child handle at all, probing the discovered port", async () => {
    setMcpHttpChild(null);
    const fetchMock = vi.fn(async () => {
      throw new Error("nope");
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).childStatus).toBe("unknown");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3457/healthz", expect.anything());
  });
});
