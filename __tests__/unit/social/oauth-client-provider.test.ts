/**
 * libi's OAuth client for a social provider. The SDK owns discovery, dynamic
 * registration, PKCE and the exchange; this class owns PERSISTENCE and the two
 * seams libi keeps for itself (where the browser is sent, and `state`).
 *
 * So these tests pin the seams and the secrecy posture, not the SDK's flow:
 * what is declared to the provider, what reaches the token store and WHEN,
 * that a state is good exactly once, and that nothing on any path prints a
 * credential.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const logSpies = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ serverLogger: logSpies, mcpLogger: logSpies }));

import { LibiOAuthClientProvider } from "@/lib/social/oauth/client-provider";
import { SocialTokenStore } from "@/lib/social/token-store";

const REDIRECT = "http://127.0.0.1:3459/api/social/oauth/callback";

function make(redirectUrl = REDIRECT, opts: { interactive?: boolean; dir?: string } = {}) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "libi-oauth-"));
  const store = new SocialTokenStore("zernio", dir);
  const redirects: URL[] = [];
  const p = new LibiOAuthClientProvider({
    providerId: "zernio", store, redirectUrl, scopes: ["posts:read"],
    onRedirect: (u) => redirects.push(u),
    // The sign-in half by default: that is the instance these tests describe.
    interactive: opts.interactive ?? true,
  });
  return { p, store, redirects, dir };
}

/** Every string below is a credential; none may appear in a log line. */
function loggedText(): string {
  return [logSpies.info, logSpies.warn, logSpies.error, logSpies.debug]
    .flatMap((spy) => spy.mock.calls)
    .map((call) => JSON.stringify(call))
    .join("\n");
}

beforeEach(() => {
  for (const spy of Object.values(logSpies)) spy.mockClear();
});

describe("LibiOAuthClientProvider", () => {
  it("declares a public loopback client with our redirect and scopes", () => {
    const { p } = make();
    expect(p.redirectUrl).toBe(REDIRECT);
    expect(p.clientMetadata).toMatchObject({
      client_name: "libi",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      scope: "posts:read",
    });
  });

  it("binds the redirect to 127.0.0.1, never to the localhost alias", () => {
    const { p } = make();
    expect(new URL(p.redirectUrl).hostname).toBe("127.0.0.1");
    expect(p.redirectUrl).not.toContain("localhost");
  });

  it("persists client info, verifier and tokens through the store, never anywhere else", async () => {
    const { p, store } = make();
    await p.saveClientInformation({ client_id: "cid", redirect_uris: [REDIRECT] });
    await p.saveCodeVerifier("ver");
    // Read back mid-flow, where the SDK reads it: the exchange needs the
    // verifier, and `saveTokens` is what spends it.
    expect(await p.clientInformation()).toMatchObject({ client_id: "cid" });
    expect(await p.codeVerifier()).toBe("ver");
    await p.saveTokens({ access_token: "at", refresh_token: "rt", token_type: "bearer", expires_in: 3600 });
    const stored = store.readSecret();
    expect(stored?.tokens.refresh_token).toBe("rt");
    expect(typeof stored?.tokens.expires_at).toBe("number");
    expect(stored?.client).toMatchObject({ client_id: "cid" });
  });

  it("writes nothing until tokens arrive, so an abandoned sign-in leaves no grant", async () => {
    const { p, store } = make();
    await p.saveClientInformation({ client_id: "cid", redirect_uris: [REDIRECT] });
    await p.saveCodeVerifier("ver");
    // Everything a sign-in stages before the browser round-trip — and the user
    // closes the tab here. Nothing on disk, so `status()` cannot read connected.
    expect(fs.existsSync(store.path())).toBe(false);
    expect(store.status().connected).toBe(false);
  });

  it("does not persist the spent PKCE verifier alongside the tokens", async () => {
    const { p, store } = make();
    await p.saveCodeVerifier("ver");
    await p.saveTokens({ access_token: "at", token_type: "bearer" });
    expect(store.readSecret()?.codeVerifier).toBeUndefined();
  });

  it("drops a registered client whose redirect no longer matches (the studio port changed)", async () => {
    const { p } = make();
    await p.saveClientInformation({ client_id: "old", redirect_uris: ["http://127.0.0.1:3999/api/social/oauth/callback"] });
    expect(await p.clientInformation()).toBeUndefined();
  });

  it("keeps that same client on a NON-interactive provider — a refresh sends no redirect URI", async () => {
    // The packaged studio port is ephemeral, so after a relaunch every stored
    // registration mismatches. Applying the sign-in filter here would hide it,
    // the SDK would register a second client, and the provider would reject a
    // refresh under a client_id the token was not issued to — which clears the
    // whole grant. The refresh keeps the registration it has.
    const { p, store, dir } = make();
    await p.saveClientInformation({ client_id: "cid", redirect_uris: [REDIRECT] });
    await p.saveTokens({ access_token: "at", refresh_token: "rt", token_type: "bearer" });
    expect(store.readSecret()?.client).toMatchObject({ client_id: "cid" });

    const relaunched = make("http://127.0.0.1:5555/api/social/oauth/callback", { interactive: false, dir }).p;
    expect(await relaunched.clientInformation()).toMatchObject({ client_id: "cid" });
    expect((await relaunched.tokens())?.refresh_token).toBe("rt");
  });

  it("reports no tokens while interactive, so clicking Connect signs in again instead of refreshing", async () => {
    // `auth()` refreshes whenever the provider hands it a refresh token and
    // returns AUTHORIZED — with no authorization URL, which the start route
    // can only turn into a 502. A user who asked to sign in gets a sign-in.
    const { p, store, dir } = make();
    await p.saveTokens({ access_token: "at", refresh_token: "rt", token_type: "bearer" });
    expect(store.status().connected).toBe(true);
    expect(await p.tokens()).toBeUndefined();
    // The grant is still there for everything that is not a sign-in.
    expect((await make(REDIRECT, { interactive: false, dir }).p.tokens())?.access_token).toBe("at");
  });

  it("carries the provider's own token_type and reads expires_in: 0 as expired", async () => {
    const { p, store, dir } = make();
    await p.saveTokens({ access_token: "at", token_type: "DPoP", expires_in: 0 });
    expect(store.readSecret()?.tokens.token_type).toBe("DPoP");
    const background = make(REDIRECT, { interactive: false, dir }).p;
    expect(await background.tokens()).toMatchObject({ token_type: "DPoP", expires_in: 0 });
  });

  it("captures the authorization URL instead of opening a browser, and state round-trips", async () => {
    const { p, redirects } = make();
    const s = await p.state();
    await p.redirectToAuthorization(new URL(`https://zernio.com/oauth/authorize?state=${s}`));
    expect(redirects[0].searchParams.get("state")).toBe(s);
    expect(p.consumeState(s)).toBe(true);
    expect(p.consumeState(s)).toBe(false); // one-shot
  });

  it("refuses a state it never handed out", () => {
    const { p } = make();
    expect(p.consumeState("forged")).toBe(false);
  });

  it("refuses a multi-byte candidate of the same string length instead of throwing", () => {
    // `timingSafeEqual` throws RangeError on unequal BYTE lengths, and the
    // candidate comes straight off the query string: "é" is one UTF-16 unit
    // and two bytes. A throw here is a 400 with a stack, not a clean refusal.
    const { p } = make();
    const s = p.state();
    expect(() => p.consumeState("é".repeat(s.length))).not.toThrow();
    expect(p.consumeState("é".repeat(s.length))).toBe(false);
    // …and the real state still works afterwards.
    expect(p.consumeState(s)).toBe(true);
  });

  it("clears the grant when the provider rejects the token, so nothing reads as connected", async () => {
    // The BACKGROUND half: a refresh whose token the provider rejected. That
    // is the only instance whose `invalidateCredentials` is about the stored
    // grant — see the interactive case below.
    const { p, store } = make(REDIRECT, { interactive: false });
    await p.saveTokens({ access_token: "at", token_type: "bearer" });
    expect(store.status().connected).toBe(true);
    await p.invalidateCredentials("tokens");
    expect(store.status().connected).toBe(false);
  });

  it("a cleared grant is marked REVOKED, so the page can say so instead of offering a first-time connect", async () => {
    const { p, store } = make(REDIRECT, { interactive: false });
    await p.saveTokens({ access_token: "at", token_type: "bearer" });
    await p.invalidateCredentials("tokens");
    expect(store.status()).toMatchObject({ connected: false, revoked: true });
  });

  /**
   * A FAILED RE-CONNECT MUST NOT DELETE A WORKING GRANT.
   *
   * `tokens()` already reports none while interactive, so an interactive
   * instance is not using the grant on disk — it is signing in on top of a
   * still-valid one. The SDK reaches `invalidateCredentials("tokens")` from
   * `auth()`'s recovery branches, which a re-connect can hit on a stale
   * consent code or an `invalid_client` during registration. Clearing there
   * destroyed a live sign-in and then told the user it had been revoked: the
   * same harm as the 403 case, from the other side.
   */
  it("an interactive sign-in that FAILS leaves the existing grant alone, and does not call it revoked", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-oauth-"));
    // The grant the user already has, written by the background half.
    const connected = make(REDIRECT, { interactive: false, dir });
    await connected.p.saveTokens({ access_token: "at", refresh_token: "rt", token_type: "bearer" });
    expect(connected.store.status()).toMatchObject({ connected: true, revoked: false });

    // Now a re-connect that dies mid-flow.
    const reconnect = make(REDIRECT, { interactive: true, dir });
    await reconnect.p.saveCodeVerifier("cv");
    await reconnect.p.invalidateCredentials("tokens");
    await reconnect.p.invalidateCredentials("all");

    expect(connected.store.status()).toMatchObject({ connected: true, revoked: false });
    // And the grant itself is intact, not merely present.
    expect(make(REDIRECT, { interactive: false, dir }).p.tokens()?.access_token).toBe("at");
  });

  it("an invalidated CLIENT registration is not a revoked grant — the token is untouched", async () => {
    const { p, store } = make();
    await p.saveClientInformation({ client_id: "cid", redirect_uris: [REDIRECT] });
    await p.saveTokens({ access_token: "at", token_type: "bearer" });
    await p.invalidateCredentials("client");
    expect(store.status()).toMatchObject({ connected: true, revoked: false });
  });

  it("a fresh sign-in after a revocation clears the marker", async () => {
    const { p, store } = make(REDIRECT, { interactive: false });
    await p.saveTokens({ access_token: "at", token_type: "bearer" });
    await p.invalidateCredentials("tokens");
    expect(store.status()).toMatchObject({ revoked: true });
    await p.saveTokens({ access_token: "at2", token_type: "bearer" });
    expect(store.status()).toMatchObject({ connected: true, revoked: false });
  });

  it("never prints a credential — not on a write, not on a missing verifier", async () => {
    const { p } = make();
    await p.saveClientInformation({ client_id: "cid", client_secret: "cs-secret", redirect_uris: [REDIRECT] });
    await p.saveCodeVerifier("cv-secret");
    await p.saveTokens({ access_token: "at-secret", refresh_token: "rt-secret", token_type: "bearer" });
    const text = loggedText();
    for (const secret of ["at-secret", "rt-secret", "cs-secret", "cv-secret"]) {
      expect(text).not.toContain(secret);
    }

    const fresh = make().p;
    // The verifier is gone (a restart mid-flow); the error names the situation
    // and carries no material.
    await expect(Promise.resolve().then(() => fresh.codeVerifier())).rejects.toThrow(/verifier/);
  });
});
