/**
 * The social service: ONE adapter per connected grant, and who is allowed to
 * end it. The lifecycle is the point — a sign-in RESETS (the next request may
 * reopen), a disconnect is TERMINAL (it may not), a 401 flips the whole
 * service to needs-reconnect — and so is what the service must never hold or
 * hand out: the grant's token.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const logSpies = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ serverLogger: logSpies, mcpLogger: logSpies }));

const settings = vi.hoisted(() => ({ providerId: "zernio" as string | null, aiLabel: true }));
vi.mock("@/lib/db/settings", () => ({
  getSocialSettings: () => ({
    providerId: settings.providerId,
    timezone: null,
    defaults: { instagramType: "reel", aiLabel: settings.aiLabel },
    pollSeconds: 30,
  }),
}));

/** The grant never reaches this module, so the OAuth provider is a placeholder. */
vi.mock("@/lib/social/oauth/flow", () => ({ providerFor: () => ({ tag: "oauth-provider" }) }));

const mcps = vi.hoisted(() => ({ opened: 0, closed: 0, connectArgs: [] as Array<Record<string, unknown>>, fail: null as Error | null, callError: null as unknown }));
vi.mock("@/lib/social/mcp-client", async (orig) => {
  const real = await orig<typeof import("@/lib/social/mcp-client")>();
  return {
    ...real,
    connectProviderMcp: async (opts: Record<string, unknown>) => {
      mcps.connectArgs.push(opts);
      if (mcps.fail) throw mcps.fail;
      mcps.opened += 1;
      return {
        async listToolNames() { return ["call_tool"]; },
        async call() { if (mcps.callError) throw mcps.callError; return {}; },
        async close() { mcps.closed += 1; },
      };
    },
  };
});

import { getSocialService, withAdapter, __setSocialServiceForTests } from "@/lib/social/service";
import { startFakeZernioIfWanted } from "@/lib/social/test-fake";
import { OAUTH_SCOPES } from "@/lib/social/catalog";
import { SocialTokenStore, type StoredGrant } from "@/lib/social/token-store";
import { SocialError } from "@/lib/social/errors";

const ACCESS = "at-super-secret";
const GRANT: StoredGrant = {
  tokens: { access_token: ACCESS, refresh_token: "rt-super-secret" },
  client: { client_id: "c", client_secret: "cs-super-secret" },
  connectedAt: "2026-09-20T00:00:00.000Z",
  scopes: ["posts:read", "posts:write"],
};

let home: string;
const realHome = process.env.LIBI_HOME;

/** Force the (lazy) connect: the holder opens a client on the first real call. */
async function touch(): Promise<void> {
  await (await getSocialService().adapter()).selfCheck();
}

/** Let the fire-and-forget close settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-social-service-"));
  process.env.LIBI_HOME = home;
  delete process.env.LIBI_TEST_MODE;
  delete process.env.LIBI_SOCIAL_MCP_URL;
  delete process.env.LIBI_SOCIAL_TEST_NO_GRANT;
  settings.providerId = "zernio";
  settings.aiLabel = true;
  mcps.opened = 0; mcps.closed = 0; mcps.connectArgs = []; mcps.fail = null; mcps.callError = null;
  __setSocialServiceForTests(null);
  for (const spy of Object.values(logSpies)) spy.mockClear();
});

afterEach(() => {
  __setSocialServiceForTests(null);
  if (realHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function connect(): void {
  new SocialTokenStore("zernio").write(GRANT);
}

describe("getSocialService — status and gating", () => {
  it("no provider chosen: not connected, and asking for an adapter is a provider error", async () => {
    settings.providerId = null;
    const svc = getSocialService();
    await expect(svc.status()).resolves.toMatchObject({ providerId: null, connected: false, needsReconnect: false });
    await expect(svc.adapter()).rejects.toMatchObject({ kind: "provider" });
  });

  it("a provider with no grant: unauthorized, and nothing is opened", async () => {
    const svc = getSocialService();
    await expect(svc.status()).resolves.toMatchObject({ connected: false, needsReconnect: false });
    await expect(svc.adapter()).rejects.toMatchObject({ kind: "unauthorized", message: "libi is not connected" });
    expect(mcps.opened).toBe(0);
  });

  it("with a grant: connected, and the status it serializes carries no credential", async () => {
    connect();
    const status = await getSocialService().status();
    expect(status).toMatchObject({ providerId: "zernio", connected: true, needsReconnect: false, scopes: ["posts:read", "posts:write"], tokenWhere: "file" });
    const wire = JSON.stringify(status);
    for (const secret of [ACCESS, "rt-super-secret", "cs-super-secret"]) expect(wire).not.toContain(secret);
  });

  it("test mode ALONE is not a connection — without a grant it reports exactly what a fresh install does", async () => {
    // The defect this pins: test mode used to be OR-ed into `connected`, so a
    // server with an empty `<LIBI_HOME>/social` answered `connected: true`
    // with no `connectedAt` and `scopes: []` — a connection nothing could
    // serve, offered to the user as one that works.
    process.env.LIBI_TEST_MODE = "1";
    process.env.LIBI_SOCIAL_MCP_URL = "http://127.0.0.1:9999/mcp";
    const st = await getSocialService().status();
    expect(st).toMatchObject({ connected: false, needsReconnect: false, scopes: [] });
    expect(st.connectedAt).toBeUndefined();
    await expect(getSocialService().adapter()).rejects.toMatchObject({ kind: "unauthorized", message: "libi is not connected" });
    expect(mcps.opened).toBe(0);
  });

  it("test mode WITH the fake's grant: connected, carrying the real scope list, and signed in with the fake's bearer", async () => {
    process.env.LIBI_TEST_MODE = "1";
    // Already set, so nothing is started — only the grant is written.
    process.env.LIBI_SOCIAL_MCP_URL = "http://127.0.0.1:9999/mcp";
    await startFakeZernioIfWanted();
    const st = await getSocialService().status();
    expect(st).toMatchObject({ connected: true, needsReconnect: false, scopes: [...OAUTH_SCOPES] });
    expect(typeof st.connectedAt).toBe("string");
    await touch();
    expect(mcps.connectArgs[0]).toEqual({ url: "http://127.0.0.1:9999/mcp", bearer: "test-mode" });
  });

  /**
   * The state a skill-eval scenario needs to exercise the agent's OWN Zernio
   * tools: the fake in front of the agent, and libi itself NOT connected. It is
   * a flag rather than an absent `LIBI_SOCIAL_MCP_URL` because unset is exactly
   * what makes `startFakeZernioIfWanted` start the fake and write the grant.
   */
  it("LIBI_SOCIAL_TEST_NO_GRANT=1 leaves libi unconnected in test mode (never-connected, not revoked)", async () => {
    process.env.LIBI_TEST_MODE = "1";
    process.env.LIBI_SOCIAL_MCP_URL = "http://127.0.0.1:9999/mcp";
    process.env.LIBI_SOCIAL_TEST_NO_GRANT = "1";
    await startFakeZernioIfWanted();
    expect(new SocialTokenStore("zernio").status().connected).toBe(false);
    const st = await getSocialService().status();
    expect(st).toMatchObject({ providerId: "zernio", connected: false, needsReconnect: false });
  });

  it("the fake's grant never overwrites a real one, and is invisible once test mode is off", async () => {
    connect();
    process.env.LIBI_TEST_MODE = "1";
    process.env.LIBI_SOCIAL_MCP_URL = "http://127.0.0.1:9999/mcp";
    await startFakeZernioIfWanted();
    expect(new SocialTokenStore("zernio").readSecret()).toEqual(GRANT);

    // …and the other way round: the fake's grant on a machine that then runs
    // without test mode must not present the fake's bearer to real Zernio.
    new SocialTokenStore("zernio").clear("disconnected");
    await startFakeZernioIfWanted();
    expect(await getSocialService().status()).toMatchObject({ connected: true });
    delete process.env.LIBI_TEST_MODE;
    __setSocialServiceForTests(null);
    expect(await getSocialService().status()).toMatchObject({ connected: false, needsReconnect: false });
  });
});

describe("getSocialService — one adapter per grant", () => {
  it("hands out the same adapter, and opens exactly one client for it", async () => {
    connect();
    const svc = getSocialService();
    const a = await svc.adapter();
    const b = await svc.adapter();
    expect(a).toBe(b);
    // The client is opened lazily, on the first call — not on adapter().
    expect(mcps.opened).toBe(0);
    await a.selfCheck();
    await b.selfCheck();
    expect(mcps.opened).toBe(1);
  });

  it("rebuilds the adapter when the AI-label default changes, so new posts carry the new value", async () => {
    connect();
    const svc = getSocialService();
    const a = await svc.adapter();
    settings.aiLabel = false;
    expect(await svc.adapter()).not.toBe(a);
  });
});

describe("getSocialService — ending a connection", () => {
  it("reset() closes the client and MAY reopen", async () => {
    connect();
    await touch();
    expect(mcps.opened).toBe(1);
    getSocialService().reset();
    await settle();
    expect(mcps.closed).toBe(1);
    await touch();
    expect(mcps.opened).toBe(2);
  });

  it("disconnect() closes the client and is TERMINAL — it never reopens, even while the grant is still on disk", async () => {
    connect();
    await touch();
    getSocialService().disconnect();
    await settle();
    expect(mcps.closed).toBe(1);
    await expect(getSocialService().adapter()).rejects.toMatchObject({ kind: "unauthorized", message: /disconnected/ });
    await expect(getSocialService().status()).resolves.toMatchObject({ connected: false });
    expect(mcps.opened).toBe(1);
  });

  it("a sign-in after a disconnect works again: reset() lifts it", async () => {
    connect();
    await touch();
    getSocialService().disconnect();
    await settle();
    getSocialService().reset();
    await touch();
    expect(mcps.opened).toBe(2);
  });

  it("markUnauthorized() flips the service to needs-reconnect and drops the client", async () => {
    connect();
    await touch();
    getSocialService().markUnauthorized();
    await settle();
    expect(mcps.closed).toBe(1);
    await expect(getSocialService().status()).resolves.toMatchObject({ connected: false, needsReconnect: true });
    await expect(getSocialService().adapter()).rejects.toMatchObject({ kind: "unauthorized", message: "libi's connection was revoked" });
  });

  it("withAdapter turns a 401 from the provider into needs-reconnect, and still throws", async () => {
    connect();
    mcps.callError = new SocialError("unauthorized", "the provider no longer accepts libi's sign-in", { status: 401 });
    await expect(withAdapter((a) => a.listAccounts())).rejects.toMatchObject({ kind: "unauthorized" });
    await expect(getSocialService().status()).resolves.toMatchObject({ connected: false, needsReconnect: true });
  });

  it("withAdapter does NOT flip a user who was never connected to 'needs reconnect'", async () => {
    // No grant: `adapter()` itself throws a 401 meaning "not connected". That
    // is not the provider rejecting anything, so the service must stay as it
    // was — a user who has never connected being told their connection was
    // revoked is a dead end with no action behind it.
    await expect(withAdapter((a) => a.listAccounts())).rejects.toMatchObject({ kind: "unauthorized", message: "libi is not connected" });
    await expect(getSocialService().status()).resolves.toMatchObject({ connected: false, needsReconnect: false });
    expect(logSpies.warn).not.toHaveBeenCalledWith(expect.objectContaining({ op: "service.unauthorized" }), expect.anything());
  });

  it("withAdapter leaves the connection alone for anything that is not a 401", async () => {
    connect();
    mcps.callError = new SocialError("rate_limited", "slow down", { status: 429, retryAt: "2026-09-20T00:00:30.000Z" });
    await expect(withAdapter((a) => a.listAccounts())).rejects.toMatchObject({ kind: "rate_limited", retryAt: "2026-09-20T00:00:30.000Z" });
    await expect(getSocialService().status()).resolves.toMatchObject({ connected: true, needsReconnect: false });
  });

  /**
   * One 403 on the Ads tab used to take the whole provider connection down
   * until the server restarted — every other tab with it. A scope gap is one
   * feature's answer, and the connection must be exactly where it was.
   */
  it("withAdapter does NOT tear the connection down for a scoped 403", async () => {
    connect();
    await touch();
    const opened = mcps.opened;
    mcps.callError = new SocialError("forbidden", "Error: [403] insufficient_permissions", { status: 403 });
    await expect(withAdapter((a) => a.listAdAccounts())).rejects.toMatchObject({ kind: "forbidden", status: 403 });
    await settle();

    await expect(getSocialService().status()).resolves.toMatchObject({ connected: true, needsReconnect: false });
    expect(logSpies.warn).not.toHaveBeenCalledWith(expect.objectContaining({ op: "service.unauthorized" }), expect.anything());
    // The client is still the one that was open — not dropped and reopened.
    expect(mcps.closed).toBe(0);
    mcps.callError = null;
    await touch();
    expect(mcps.opened).toBe(opened);
  });
});

/**
 * The third layer of the live defect: the grant really WAS cleared, and the
 * page then told the user they had never connected — no explanation, no hint
 * that anything had been taken away. `status()` has to tell the two apart
 * from what is left on disk, because the in-memory flag does not survive the
 * restart that usually follows.
 */
describe("getSocialService — a revoked grant never reads as 'never connected'", () => {
  it("a grant cleared as revoked reports needsReconnect, with no grant on disk", async () => {
    connect();
    new SocialTokenStore("zernio").clear("revoked");
    await expect(getSocialService().status()).resolves.toMatchObject({
      providerId: "zernio",
      connected: false,
      needsReconnect: true,
    });
  });

  it("…and survives a restart: a service built fresh over the same home still says so", async () => {
    connect();
    new SocialTokenStore("zernio").clear("revoked");
    // A brand-new service, as a relaunched server would build.
    __setSocialServiceForTests(null);
    await expect(getSocialService().status()).resolves.toMatchObject({ connected: false, needsReconnect: true });
  });

  it("a grant the USER disconnected reads as not connected, never as revoked", async () => {
    connect();
    new SocialTokenStore("zernio").clear("disconnected");
    await expect(getSocialService().status()).resolves.toMatchObject({ connected: false, needsReconnect: false });
  });

  it("a fresh install is still 'never connected'", async () => {
    await expect(getSocialService().status()).resolves.toMatchObject({ connected: false, needsReconnect: false });
  });

  it("reconnecting clears it: a new grant is connected and no longer needs reconnecting", async () => {
    connect();
    new SocialTokenStore("zernio").clear("revoked");
    await expect(getSocialService().status()).resolves.toMatchObject({ needsReconnect: true });

    connect();
    getSocialService().reset();
    await expect(getSocialService().status()).resolves.toMatchObject({ connected: true, needsReconnect: false });
  });
});

/**
 * The live defect, at the seam it was found on: a running server answering
 * `connected: true` over an EMPTY `<LIBI_HOME>/social`. The grant can leave
 * under a process that is already serving — the SDK's auth recovery clears it
 * from inside a request, and another process can disconnect — so "connected"
 * may never be something this one decided once and kept saying.
 */
describe("getSocialService — a grant that vanishes under a running process", () => {
  it("the next status is not-connected, the held client is let go, and the verification goes with it", async () => {
    connect();
    await touch();
    const before = await getSocialService().status();
    expect(before).toMatchObject({ connected: true, scopes: GRANT.scopes });
    expect(typeof before.lastVerifiedAt).toBe("string");

    // No clear(), no restart: the file simply goes.
    fs.rmSync(new SocialTokenStore("zernio").path(), { force: true });

    const after = await getSocialService().status();
    expect(after).toMatchObject({ connected: false, needsReconnect: false, scopes: [] });
    expect(after.connectedAt).toBeUndefined();
    // `lastVerifiedAt` is a claim about a grant that no longer exists. Keeping
    // it is how the UI printed "Last verified …" under a connection that had
    // already been destroyed.
    expect(after.lastVerifiedAt).toBeUndefined();

    await settle();
    expect(mcps.closed).toBe(1);
    await expect(getSocialService().adapter()).rejects.toMatchObject({ kind: "unauthorized", message: "libi is not connected" });
  });

  it("does not reopen a client for a grant that is gone", async () => {
    connect();
    await touch();
    fs.rmSync(new SocialTokenStore("zernio").path(), { force: true });
    await expect(getSocialService().adapter()).rejects.toMatchObject({ kind: "unauthorized" });
    expect(mcps.opened).toBe(1);
  });
});
