/**
 * "Connect libi" must send the browser back to the port the studio is REALLY
 * serving on — SOC-3, found on the installed 0.1.16 desktop app, where Zernio
 * sent the user to `http://127.0.0.1:3000/api/social/oauth/callback` and the
 * connection was refused.
 *
 * The cause was Next, not libi's arithmetic: libi's production servers
 * (`lib/server/next-server.ts` for the packaged app, `lib/cli/studio.ts` for
 * npx) build their Next app without a `port`, and Next 16 then synthesizes a
 * route handler's `request.url` as `http://localhost:3000/<path>` whatever
 * port the socket is on (`next.js` → `port: this.options.port || 3000`,
 * `resolve-routes.js` → `initURL`). The start route read its port off that
 * URL. Only `next dev` passes its real port, which is why dev never showed it —
 * and why the older route test, which built its Request on the real port, never
 * saw it either.
 *
 * So these requests are built the way Next hands them over: `request.url` on
 * `localhost:3000`, the browser's real `Host` on the real port. The SDK's
 * `auth()` is REAL here, against a stubbed Zernio, so what is asserted is what
 * actually leaves libi — the `redirect_uris` in the dynamic client
 * registration, and the `redirect_uri` in the authorize URL the page opens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const logSpies = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ serverLogger: logSpies, mcpLogger: logSpies }));

vi.mock("@/lib/db/settings", () => ({
  getSocialSettings: () => ({
    providerId: "zernio",
    timezone: null,
    defaults: { instagramType: "reel", aiLabel: true },
    pollSeconds: 30,
  }),
}));

import { POST as startRoute } from "@/app/api/social/oauth/start/route";
import { __resetOAuthFlowForTests } from "@/lib/social/oauth/flow";
import { resolvePortToPublish } from "@/lib/libi-home";

/** What Next 16 gives a route handler under a custom server built with no
 *  `port`: never the socket's port. */
const NEXT_SYNTHESIZED_URL = "http://localhost:3000/api/social/oauth/start";

/** A minimal Zernio: protected-resource metadata, authorization-server
 *  metadata, and a registration endpoint that records what it was sent. */
function fakeZernio() {
  const registrations: Array<{ redirect_uris?: string[] }> = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json({ resource: "https://mcp.zernio.com/mcp", authorization_servers: ["https://zernio.com"] });
    }
    if (url.host === "zernio.com" && url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: "https://zernio.com",
        authorization_endpoint: "https://zernio.com/oauth/authorize",
        token_endpoint: "https://zernio.com/oauth/token",
        registration_endpoint: "https://zernio.com/oauth/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.host === "zernio.com" && url.pathname === "/oauth/register" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { redirect_uris?: string[] };
      registrations.push(body);
      return json({ ...body, client_id: `cid-${registrations.length}` }, 201);
    }
    return new Response("not found", { status: 404 });
  };
  return { registrations, fetchImpl };
}

let home: string;
let zernio: ReturnType<typeof fakeZernio>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-oauth-real-port-"));
  vi.stubEnv("LIBI_HOME", home);
  __resetOAuthFlowForTests();
  for (const spy of Object.values(logSpies)) spy.mockClear();
  zernio = fakeZernio();
  vi.stubGlobal("fetch", zernio.fetchImpl);
});

afterEach(() => {
  __resetOAuthFlowForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * The two production launches, as the environment Category B leaves behind:
 *  - packaged: `startNextServer` binds `listen(0)`, sets PORT/LIBI_PORT to the
 *    bound port, and Category B publishes it as LIBI_SERVER_PORT. The window
 *    loads `127.0.0.1:<port>`.
 *  - npx: `startStudio` sets PORT to the requested port (3456 by default,
 *    `--port` otherwise) and opens `localhost:<port>` in the user's browser.
 */
const LAUNCHES = [
  { name: "packaged (ephemeral port)", port: 51234, pageHost: "127.0.0.1", env: { PORT: "51234", LIBI_PORT: "51234" } },
  { name: "npx (--port 3491)", port: 3491, pageHost: "localhost", env: { PORT: "3491" } },
] as const;

describe("/api/social/oauth/start — the redirect is on the studio's REAL port, not Next's synthesized :3000", () => {
  it.each(LAUNCHES)("$name", async ({ port, pageHost, env }) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    // The real launch path (`lib/libi-home.ts#resolvePortToPublish`): Category B derives
    // LIBI_SERVER_PORT from PORT/LIBI_PORT, never from a literal — so this exercises the
    // SAME derivation a packaged or npx launch does, instead of asserting a hand-picked
    // LIBI_SERVER_PORT that would pass even if PORT/LIBI_PORT were wired up wrong.
    vi.stubEnv("LIBI_SERVER_PORT", String(resolvePortToPublish().port));
    const authority = `${pageHost}:${port}`;

    const res = await startRoute(new Request(NEXT_SYNTHESIZED_URL, {
      method: "POST",
      headers: { host: authority, origin: `http://${authority}`, "sec-fetch-site": "same-origin" },
    }));
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };

    const expected = `http://127.0.0.1:${port}/api/social/oauth/callback`;
    // What Zernio sends the browser back to.
    const authorize = new URL(url);
    expect(authorize.origin + authorize.pathname).toBe("https://zernio.com/oauth/authorize");
    expect(authorize.searchParams.get("redirect_uri")).toBe(expected);
    // What Zernio will ACCEPT as a redirect: the client registered for it.
    expect(zernio.registrations).toHaveLength(1);
    expect(zernio.registrations[0].redirect_uris).toEqual([expected]);
    // And nowhere on Next's phantom port.
    expect(url).not.toContain(":3000");
    expect(JSON.stringify(zernio.registrations)).not.toContain(":3000");
  });
});

describe("/api/social/oauth/start — with no usable studio port", () => {
  it("502s and registers nothing, rather than guessing a port", async () => {
    vi.stubEnv("LIBI_SERVER_PORT", "not-a-port");
    const res = await startRoute(new Request(NEXT_SYNTHESIZED_URL, {
      method: "POST",
      headers: { host: "127.0.0.1:51234", origin: "http://127.0.0.1:51234", "sec-fetch-site": "same-origin" },
    }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "start_failed" });
    expect(zernio.registrations).toHaveLength(0);
  });
});
