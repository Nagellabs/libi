/**
 * The sign-in flow: the studio starts it, the user's browser finishes it on
 * the loopback callback. The SDK's `auth()` is mocked here because what is
 * being pinned is libi's half — the redirect URL, the one-shot `state`, and
 * the promise that a flow which does not finish leaves nothing behind (no
 * grant on disk, no entry still waiting to accept a callback).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const logSpies = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ serverLogger: logSpies, mcpLogger: logSpies }));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", async (orig) => {
  const real = await orig<typeof import("@modelcontextprotocol/sdk/client/auth.js")>();
  return { ...real, auth: vi.fn() };
});

import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  startSignIn, finishSignIn, cancelSignIn, disconnect, redirectUrlFor, providerFor,
  PENDING_SIGN_IN_TTL_MS, __resetOAuthFlowForTests, SignInWindowExpiredError,
} from "@/lib/social/oauth/flow";
import { SocialTokenStore } from "@/lib/social/token-store";

let home: string;
const realHome = process.env.LIBI_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-oauth-flow-"));
  process.env.LIBI_HOME = home;
  __resetOAuthFlowForTests();
  vi.mocked(auth).mockReset();
  for (const spy of Object.values(logSpies)) spy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  if (realHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = realHome;
});

/** The SDK's two halves: hand back a redirect, then exchange the code. */
function mockAuth(opts: { authorizeUrl?: string } = {}) {
  vi.mocked(auth).mockImplementation(async (provider, options) => {
    if (!options.authorizationCode) {
      const s = await provider.state!();
      const base = opts.authorizeUrl ?? "https://zernio.com/oauth/authorize";
      await provider.redirectToAuthorization(new URL(`${base}?state=${s}&client_id=x`));
      return "REDIRECT";
    }
    await provider.saveTokens({ access_token: "at-secret", refresh_token: "rt-secret", token_type: "bearer" });
    return "AUTHORIZED";
  });
}

/**
 * A fuller stand-in for the SDK + the provider: registrations are remembered,
 * and a refresh presented under a `client_id` the token was NOT issued to is
 * rejected exactly the way `auth()` handles that — `invalidateCredentials`
 * with scope "tokens", which in libi's provider clears the whole grant. That
 * is the chain the port-change test has to walk; `mockAuth` above is too
 * forgiving to show it.
 */
function mockAuthWithRegistry() {
  let issuedTo: string | undefined;
  let nextClientId = 1;
  vi.mocked(auth).mockImplementation(async (provider, options) => {
    let client = await provider.clientInformation();
    if (!client) {
      const fresh = { client_id: `cid-${nextClientId++}`, redirect_uris: [String(provider.redirectUrl)] };
      await provider.saveClientInformation!(fresh);
      client = fresh;
    }
    if (options.authorizationCode) {
      issuedTo = client.client_id;
      await provider.saveTokens({ access_token: "at-1", refresh_token: "rt-1", token_type: "bearer" });
      return "AUTHORIZED";
    }
    const tokens = await provider.tokens();
    if (tokens?.refresh_token) {
      if (client.client_id !== issuedTo) {
        await provider.invalidateCredentials!("tokens");
        throw new Error("invalid_grant");
      }
      await provider.saveTokens({ access_token: "at-2", refresh_token: "rt-1", token_type: "bearer" });
      return "AUTHORIZED";
    }
    const s = await provider.state!();
    await provider.redirectToAuthorization(new URL(`https://zernio.com/oauth/authorize?state=${s}`));
    return "REDIRECT";
  });
}

function loggedText(): string {
  return [logSpies.info, logSpies.warn, logSpies.error, logSpies.debug]
    .flatMap((spy) => spy.mock.calls)
    .map((call) => JSON.stringify(call))
    .join("\n");
}

describe("oauth flow", () => {
  it("redirect URL is loopback on the studio port", () => {
    expect(redirectUrlFor(3459)).toBe("http://127.0.0.1:3459/api/social/oauth/callback");
  });

  it("startSignIn returns the authorize URL the SDK asked to open, tagged with our state", async () => {
    mockAuth();
    const r = await startSignIn("zernio", 3459);
    expect(r.url).toContain("https://zernio.com/oauth/authorize?");
    expect(new URL(r.url).searchParams.get("state")).toBe(r.state);
    expect(vi.mocked(auth).mock.calls[0][1]).toMatchObject({
      serverUrl: "https://mcp.zernio.com/mcp",
      scope: "accounts:read posts:read posts:write analytics:read",
    });
  });

  it("asks for exactly the catalog scopes — no ads scope", async () => {
    mockAuth();
    await startSignIn("zernio", 3459);
    const scope = String(vi.mocked(auth).mock.calls[0][1].scope);
    expect(scope.split(" ").sort()).toEqual(["accounts:read", "analytics:read", "posts:read", "posts:write"]);
    expect(scope).not.toContain("ads");
  });

  it("finishSignIn rejects an unknown state and completes a known one exactly once", async () => {
    mockAuth();
    const r = await startSignIn("zernio", 3459);
    await expect(finishSignIn({ code: "c", state: "nope" })).rejects.toThrow(/state/);
    await expect(finishSignIn({ code: "c", state: r.state })).resolves.toEqual({ providerId: "zernio" });
    await expect(finishSignIn({ code: "c", state: r.state })).rejects.toThrow(/state/);
  });

  it("stops accepting a callback once the sign-in window has passed, and says THAT is what happened", async () => {
    vi.useFakeTimers();
    mockAuth();
    const r = await startSignIn("zernio", 3459);
    vi.advanceTimersByTime(PENDING_SIGN_IN_TTL_MS + 1);
    // An expired window is a different answer from a forged state — the
    // callback page can only tell the user which it is if the flow says so
    // (QA 2026-09-21, finding 11). Nothing is stored either way.
    await expect(finishSignIn({ code: "c", state: r.state })).rejects.toThrow(SignInWindowExpiredError);
    expect(new SocialTokenStore("zernio").status().connected).toBe(false);
    // Spent on the way past: a replay afterwards is back to the generic
    // refusal, so an expired state cannot be presented twice for a nicer
    // answer than it deserves.
    await expect(finishSignIn({ code: "c", state: r.state })).rejects.toThrow(/unknown or already-used/);
  });

  it("an unknown state is never reported as an expiry", async () => {
    mockAuth();
    await startSignIn("zernio", 3459);
    await expect(finishSignIn({ code: "c", state: "forged" })).rejects.not.toThrow(SignInWindowExpiredError);
  });

  it("a cancelled sign-in stops accepting its callback and leaves no grant", async () => {
    mockAuth();
    const r = await startSignIn("zernio", 3459);
    cancelSignIn(r.state);
    await expect(finishSignIn({ code: "c", state: r.state })).rejects.toThrow(/state/);
    expect(fs.existsSync(new SocialTokenStore("zernio").path())).toBe(false);
  });

  it("a failed exchange writes no partial grant and does not leave the state usable", async () => {
    vi.mocked(auth).mockImplementation(async (provider, options) => {
      if (!options.authorizationCode) {
        const s = await provider.state!();
        await provider.saveCodeVerifier("cv-secret");
        await provider.redirectToAuthorization(new URL(`https://zernio.com/oauth/authorize?state=${s}`));
        return "REDIRECT";
      }
      throw new Error("token endpoint said no");
    });
    const r = await startSignIn("zernio", 3459);
    await expect(finishSignIn({ code: "c", state: r.state })).rejects.toThrow(/token endpoint/);
    expect(fs.existsSync(new SocialTokenStore("zernio").path())).toBe(false);
    await expect(finishSignIn({ code: "c", state: r.state })).rejects.toThrow(/state/);
  });

  it("two concurrent sign-ins keep their own state and verifier", async () => {
    const verifiers = new Map<string, string>();
    vi.mocked(auth).mockImplementation(async (provider, options) => {
      if (!options.authorizationCode) {
        const s = await provider.state!();
        await provider.saveCodeVerifier(`cv-${s}`);
        await provider.redirectToAuthorization(new URL(`https://zernio.com/oauth/authorize?state=${s}`));
        return "REDIRECT";
      }
      const v = await provider.codeVerifier();
      verifiers.set(options.authorizationCode, v);
      await provider.saveTokens({ access_token: `at-${options.authorizationCode}`, token_type: "bearer" });
      return "AUTHORIZED";
    });
    const [a, b] = await Promise.all([startSignIn("zernio", 3459), startSignIn("zernio", 3459)]);
    expect(a.state).not.toBe(b.state);
    await finishSignIn({ code: "first", state: a.state });
    await finishSignIn({ code: "second", state: b.state });
    expect(verifiers.get("first")).toBe(`cv-${a.state}`);
    expect(verifiers.get("second")).toBe(`cv-${b.state}`);
    // The second one to finish is the grant that stands; neither wrote the other's.
    expect(new SocialTokenStore("zernio").readSecret()?.tokens.access_token).toBe("at-second");
  });

  it("a refresh after the studio port changed keeps the grant", async () => {
    mockAuthWithRegistry();
    const store = new SocialTokenStore("zernio");
    const r = await startSignIn("zernio", 3459);
    await finishSignIn({ code: "c", state: r.state });
    expect(store.status().connected).toBe(true);

    // Relaunch. The packaged studio port is ephemeral, so the registration
    // stored a moment ago lists a redirect URI that is no longer today's. A
    // refresh sends no redirect URI at all, so it must use that registration
    // anyway: re-registering here would present the provider a client_id the
    // token was never issued to, and the rejection clears the sign-in.
    const refreshing = providerFor("zernio", 7777);
    await expect(auth(refreshing, { serverUrl: "https://mcp.zernio.com/mcp" })).resolves.toBe("AUTHORIZED");
    expect(store.status().connected).toBe(true);
    expect(store.readSecret()?.tokens.access_token).toBe("at-2");
    expect(store.readSecret()?.client).toMatchObject({ client_id: "cid-1" });
  });

  it("starting a sign-in while already connected still returns an authorization URL", async () => {
    mockAuthWithRegistry();
    const first = await startSignIn("zernio", 3459);
    await finishSignIn({ code: "c", state: first.state });
    expect(new SocialTokenStore("zernio").status().connected).toBe(true);

    // Connect clicked again (a reconnect, or a scope change). `auth()` would
    // refresh and answer AUTHORIZED if the provider showed it the live grant —
    // no authorization URL, and the start route's only move is a 502.
    const again = await startSignIn("zernio", 3459);
    expect(again.url).toContain("https://zernio.com/oauth/authorize");
    await finishSignIn({ code: "c2", state: again.state });
    expect(new SocialTokenStore("zernio").readSecret()?.tokens.access_token).toBe("at-1");
  });

  it("disconnect removes the grant", async () => {
    mockAuth();
    const r = await startSignIn("zernio", 3459);
    await finishSignIn({ code: "c", state: r.state });
    expect(new SocialTokenStore("zernio").status().connected).toBe(true);
    disconnect("zernio");
    expect(new SocialTokenStore("zernio").status().connected).toBe(false);
    expect(fs.existsSync(new SocialTokenStore("zernio").path())).toBe(false);
  });

  it("logs the flow without ever logging what it obtained", async () => {
    mockAuth();
    const r = await startSignIn("zernio", 3459);
    await finishSignIn({ code: "c", state: r.state });
    const text = loggedText();
    expect(text).toContain("oauth.start");
    expect(text).not.toContain("at-secret");
    expect(text).not.toContain("rt-secret");
    // The authorization code and state are single-use, but they are still
    // material from the URL bar — they do not belong in the log either.
    expect(text).not.toContain(r.state);
  });
});
