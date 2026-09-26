/**
 * The three OAuth routes. The contract they carry is narrow and absolute: the
 * grant libi obtains is the one provider credential it ever holds, so no
 * response body, redirect or log line these routes produce may contain it —
 * the start route answers with a URL for the page to open, the callback
 * answers with HTML for the tab the user is sitting in, and neither ever
 * echoes what was exchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const logSpies = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ serverLogger: logSpies, mcpLogger: logSpies }));

const settings = vi.hoisted(() => ({ providerId: "zernio" as string | null }));
vi.mock("@/lib/db/settings", () => ({
  getSocialSettings: () => ({
    providerId: settings.providerId,
    timezone: null,
    defaults: { instagramType: "reel", aiLabel: true },
    pollSeconds: 30,
  }),
}));

const tracked = vi.hoisted(() => ({ calls: [] as Array<[string, Record<string, unknown> | undefined]> }));
vi.mock("@/lib/analytics/server", () => ({
  trackServerEvent: (name: string, params?: Record<string, unknown>) => { tracked.calls.push([name, params]); },
}));

/** The stub is a live MCP client now, so WHEN the service is told stops being
 *  free: a completed sign-in RESETS (the next request may reopen), and a
 *  disconnect is TERMINAL. Both are counted here rather than assumed. */
const service = vi.hoisted(() => ({ resets: 0, disconnects: 0 }));
vi.mock("@/lib/social/service", () => ({
  getSocialService: () => ({
    reset: () => { service.resets += 1; },
    disconnect: () => { service.disconnects += 1; },
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", async (orig) => {
  const real = await orig<typeof import("@modelcontextprotocol/sdk/client/auth.js")>();
  return { ...real, auth: vi.fn() };
});

import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { POST as startRoute } from "@/app/api/social/oauth/start/route";
import { GET as callbackRoute } from "@/app/api/social/oauth/callback/route";
import { POST as disconnectRoute } from "@/app/api/social/oauth/disconnect/route";
import { __resetOAuthFlowForTests, PENDING_SIGN_IN_TTL_MS } from "@/lib/social/oauth/flow";
import { SocialTokenStore } from "@/lib/social/token-store";

const ACCESS = "at-super-secret";
let home: string;
const realHome = process.env.LIBI_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-oauth-routes-"));
  process.env.LIBI_HOME = home;
  settings.providerId = "zernio";
  tracked.calls.length = 0;
  service.resets = 0;
  service.disconnects = 0;
  __resetOAuthFlowForTests();
  vi.mocked(auth).mockReset();
  for (const spy of Object.values(logSpies)) spy.mockClear();
  vi.mocked(auth).mockImplementation(async (provider, options) => {
    if (!options.authorizationCode) {
      const s = await provider.state!();
      await provider.redirectToAuthorization(new URL(`https://zernio.com/oauth/authorize?state=${s}&client_id=x`));
      return "REDIRECT";
    }
    await provider.saveTokens({ access_token: ACCESS, refresh_token: "rt-super-secret", token_type: "bearer" });
    return "AUTHORIZED";
  });
});

afterEach(() => {
  if (realHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = realHome;
});

function loggedText(): string {
  return [logSpies.info, logSpies.warn, logSpies.error, logSpies.debug]
    .flatMap((spy) => spy.mock.calls)
    .map((call) => JSON.stringify(call))
    .join("\n");
}

/** The Social page's Connect / Disconnect click: a same-origin browser fetch.
 *  Both routes take the browser-only checks; a header-less caller's refusal is
 *  covered in __tests__/unit/security/user-only-routes.test.ts. */
const PAGE = { host: "127.0.0.1:3459", origin: "http://127.0.0.1:3459", "sec-fetch-site": "same-origin" };
const disconnectReq = () => new Request("http://127.0.0.1:3459/api/social/oauth/disconnect", { method: "POST", headers: PAGE });

async function start(): Promise<{ status: number; url?: string; state?: string; body: string }> {
  const res = await startRoute(new Request("http://127.0.0.1:3459/api/social/oauth/start", { method: "POST", headers: PAGE }));
  const body = await res.text();
  if (res.status !== 200) return { status: res.status, body };
  const parsed = JSON.parse(body) as { url: string };
  return { status: res.status, url: parsed.url, state: new URL(parsed.url).searchParams.get("state") ?? undefined, body };
}

describe("/api/social/oauth/start", () => {
  it("answers with the authorize URL on the studio's own loopback redirect, and nothing else", async () => {
    const r = await start();
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ url: r.url });
    expect(r.url).toContain("https://zernio.com/oauth/authorize?");
    const redirect = String(vi.mocked(auth).mock.calls[0][0].redirectUrl);
    expect(redirect).toBe("http://127.0.0.1:3459/api/social/oauth/callback");
  });

  it("409s when no provider has been chosen", async () => {
    settings.providerId = null;
    const r = await start();
    expect(r.status).toBe(409);
  });

  it("invalidates nothing — the grant has not changed, and this sign-in may never finish", async () => {
    // Once `reset()` tears down a live MCP client (Task 8), doing it here
    // would kill a working session the moment the user clicks Connect.
    const r = await start();
    expect(r.status).toBe(200);
    expect(service.resets).toBe(0);
  });

  it("502s without leaking the reason to the browser when the provider is unreachable", async () => {
    vi.mocked(auth).mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:443"));
    const r = await start();
    expect(r.status).toBe(502);
    expect(r.body).not.toContain("ECONNREFUSED");
    expect(loggedText()).toContain("oauth.start_failed");
  });

  it("logs the error's NAME, never its message — the SDK puts the request body in there", async () => {
    // The shape `parseErrorResponse` (SDK client/auth.js) builds for any
    // non-OAuth-shaped error body from the registration or token endpoint. A
    // provider that echoes the request hands back the PKCE verifier inside it.
    const err = new Error(
      "HTTP 400: Invalid OAuth error response: x. " +
      "Raw body: {\"echo\":\"code_verifier=cv-super-secret&client_id=x\"}",
    );
    err.name = "TypeError";
    vi.mocked(auth).mockRejectedValue(err);
    const r = await start();
    expect(r.status).toBe(502);
    const text = loggedText();
    expect(text).toContain("oauth.start_failed");
    expect(text).toContain("TypeError");
    expect(text).not.toContain("cv-super-secret");
    expect(text).not.toContain("Raw body");
  });
});

describe("/api/social/oauth/callback", () => {
  it("completes the grant and answers HTML that carries no token", async () => {
    const s = await start();
    const res = await callbackRoute(new Request(
      `http://127.0.0.1:3459/api/social/oauth/callback?code=abc&state=${s.state}`,
    ));
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).not.toContain(ACCESS);
    expect(html).not.toContain("rt-super-secret");
    expect(html).not.toContain("abc");
    expect(new SocialTokenStore("zernio").status().connected).toBe(true);
    expect(tracked.calls).toEqual([["social_libi_connected", { provider: "zernio" }]]);
    expect(loggedText()).not.toContain(ACCESS);
    // The grant HAS changed here, so this is where anything cached against the
    // old one is dropped.
    expect(service.resets).toBe(1);
  });

  it("rejects a state it never handed out, and stores nothing", async () => {
    await start();
    const res = await callbackRoute(new Request(
      "http://127.0.0.1:3459/api/social/oauth/callback?code=abc&state=forged",
    ));
    expect(res.status).toBe(400);
    expect(new SocialTokenStore("zernio").status().connected).toBe(false);
    expect(tracked.calls).toEqual([]);
  });

  it("refuses to replay a state that already completed", async () => {
    const s = await start();
    const url = `http://127.0.0.1:3459/api/social/oauth/callback?code=abc&state=${s.state}`;
    expect((await callbackRoute(new Request(url))).status).toBe(200);
    expect((await callbackRoute(new Request(url))).status).toBe(400);
  });

  /** QA 2026-09-21, finding 11: an expired window answered "Sign-in failed.
   *  Go back to libi and try Connect again", although the server knew exactly
   *  what had happened — and "failed" sends the user looking for a fault. */
  it("says the window EXPIRED when that is what happened, rather than that the sign-in failed", async () => {
    vi.useFakeTimers();
    const s = await start();
    vi.advanceTimersByTime(PENDING_SIGN_IN_TTL_MS + 1);
    const res = await callbackRoute(new Request(
      `http://127.0.0.1:3459/api/social/oauth/callback?code=abc&state=${s.state}`,
    ));
    const html = await res.text();
    expect(res.status).toBe(400);
    expect(html).toContain("Sign-in window expired");
    expect(html).not.toContain("Sign-in failed");
    expect(html).toContain("Nothing went wrong and nothing was changed");
    // Still nothing stored, and still nothing from the query reflected back.
    expect(new SocialTokenStore("zernio").status().connected).toBe(false);
    expect(html).not.toContain("abc");
    expect(tracked.calls).toEqual([]);
    vi.useRealTimers();
  });

  it("still says 'failed' for a state it never handed out — an expiry is not the excuse for every refusal", async () => {
    await start();
    const res = await callbackRoute(new Request(
      "http://127.0.0.1:3459/api/social/oauth/callback?code=abc&state=forged",
    ));
    const html = await res.text();
    expect(html).toContain("Sign-in failed");
    expect(html).not.toContain("expired");
  });

  it("treats the provider's own error as a cancellation and drops the pending sign-in", async () => {
    const s = await start();
    const denied = await callbackRoute(new Request(
      `http://127.0.0.1:3459/api/social/oauth/callback?error=access_denied&state=${s.state}`,
    ));
    expect(denied.status).toBe(400);
    expect(new SocialTokenStore("zernio").status().connected).toBe(false);
    // The window is shut: the code that arrives after the denial is refused.
    const late = await callbackRoute(new Request(
      `http://127.0.0.1:3459/api/social/oauth/callback?code=abc&state=${s.state}`,
    ));
    expect(late.status).toBe(400);
  });

  it("logs a failed exchange by name only — its message can quote the code and verifier back", async () => {
    const s = await start();
    const err = new Error(
      "HTTP 400: Invalid OAuth error response: x. " +
      "Raw body: code=auth-code-secret&code_verifier=cv-super-secret",
    );
    err.name = "SyntaxError";
    vi.mocked(auth).mockImplementation(async (provider, options) => {
      if (!options.authorizationCode) {
        const st = await provider.state!();
        await provider.redirectToAuthorization(new URL(`https://zernio.com/oauth/authorize?state=${st}`));
        return "REDIRECT";
      }
      throw err;
    });
    const res = await callbackRoute(new Request(
      `http://127.0.0.1:3459/api/social/oauth/callback?code=auth-code-secret&state=${s.state}`,
    ));
    expect(res.status).toBe(400);
    const text = loggedText();
    expect(text).toContain("oauth.callback_failed");
    expect(text).toContain("SyntaxError");
    expect(text).not.toContain("cv-super-secret");
    expect(text).not.toContain("auth-code-secret");
    expect(text).not.toContain("Raw body");
  });

  it("does not reflect the provider's error text into the page", async () => {
    const res = await callbackRoute(new Request(
      "http://127.0.0.1:3459/api/social/oauth/callback?error=%3Cscript%3Ealert(1)%3C/script%3E",
    ));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("<script>alert(1)");
  });
});

describe("/api/social/oauth/disconnect", () => {
  it("removes the grant and answers without one", async () => {
    const s = await start();
    await callbackRoute(new Request(`http://127.0.0.1:3459/api/social/oauth/callback?code=abc&state=${s.state}`));
    const res = await disconnectRoute(disconnectReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(new SocialTokenStore("zernio").status().connected).toBe(false);
    // The sign-in that just completed reset the service; the disconnect is
    // TERMINAL instead — a reset here would let the next request reopen a
    // client against a grant the user just removed.
    expect(service.resets).toBe(1);
    expect(service.disconnects).toBe(1);
  });

  it("409s when no provider has been chosen", async () => {
    settings.providerId = null;
    expect((await disconnectRoute(disconnectReq())).status).toBe(409);
  });
});
