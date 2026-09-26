import { randomBytes, timingSafeEqual } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { SocialProviderId } from "@/lib/social/catalog";
import type { SocialTokenStore, StoredGrant } from "@/lib/social/token-store";

/**
 * The SDK drives discovery, dynamic client registration, PKCE and the token
 * exchange (`auth()` in client/auth.js); this class is only the PERSISTENCE and
 * the two seams libi owns: where the browser is sent (captured, not opened —
 * the route returns the URL and the page opens it) and the one-shot `state`.
 *
 * **Nothing is written until tokens arrive.** Registration and the PKCE
 * verifier are staged in memory and committed by `saveTokens` in one write.
 * The reason is the token store's own contract: "connected" there means "a
 * grant file exists", so a sign-in that staged a verifier and was then
 * abandoned — the user closed the tab — would otherwise leave a grant with no
 * token in it that every reader calls connected. Staging costs nothing,
 * because both halves of a flow run against the same instance held by
 * `lib/social/oauth/flow.ts`; a restart mid-flow loses the pending sign-in
 * either way.
 *
 * `interactive` says which half of the grant's life this instance is for, and
 * it changes two answers:
 *
 * - **The registered client.** It is bound to its redirect URI, and the
 *   packaged studio port is ephemeral, so on an INTERACTIVE sign-in a client
 *   registered on another port is discarded and re-registered (dynamic
 *   registration is free) rather than failing the exchange with
 *   redirect_uri_mismatch. A REFRESH sends no redirect URI at all, so the same
 *   filter there would be pure harm: after a relaunch on a new port it would
 *   hide a perfectly good registration, the SDK would register a SECOND client,
 *   and the provider would reject a refresh presented under a `client_id` the
 *   token was not issued to — which lands in `invalidateCredentials("tokens")`
 *   and wipes the user's sign-in. So the filter applies only when interactive.
 * - **The tokens.** An interactive start reports NONE, whatever is stored.
 *   `auth()` refreshes instead of authorizing whenever the provider hands it a
 *   refresh token, so a user who clicks Connect while already connected would
 *   get `AUTHORIZED` back and no authorization URL — surfacing as a 502. The
 *   user asked to sign in; a sign-in is what this has to run, and the grant it
 *   completes with replaces the old one.
 */
export class LibiOAuthClientProvider implements OAuthClientProvider {
  /** States handed out by `state()` and not yet spent. */
  private readonly pendingStates = new Set<string>();
  /** Writes held back until `saveTokens` commits them. */
  private staged: Partial<StoredGrant> = {};

  constructor(private readonly opts: {
    providerId: SocialProviderId;
    store: SocialTokenStore;
    redirectUrl: string;
    scopes: readonly string[];
    onRedirect: (url: URL) => void;
    /** True for a browser sign-in the user just started; false for a refresh
     *  or any other background use of the stored grant. See the class note. */
    interactive: boolean;
  }) {}

  get providerId(): SocialProviderId { return this.opts.providerId; }

  get redirectUrl(): string { return this.opts.redirectUrl; }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "libi",
      client_uri: "https://libi.video",
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: this.opts.scopes.join(" "),
    };
  }

  state(): string {
    const s = randomBytes(32).toString("hex");
    this.pendingStates.add(s);
    return s;
  }

  /**
   * True once per state handed out by `state()` — a forged or replayed one is
   * false. Compared in constant time so the answer cannot be walked out of it
   * a byte at a time, and the match is removed as it is read, which is what
   * makes a callback single-use.
   */
  consumeState(candidate: string): boolean {
    const given = Buffer.from(candidate);
    for (const known of this.pendingStates) {
      const mine = Buffer.from(known);
      // BYTE length, not string length: `timingSafeEqual` throws RangeError on
      // buffers of different sizes, and two strings of equal UTF-16 length can
      // encode to different byte counts (any multi-byte character does it).
      // Our own states are hex, but the candidate comes off the query string.
      if (mine.length !== given.length) continue;
      if (!timingSafeEqual(mine, given)) continue;
      this.pendingStates.delete(known);
      return true;
    }
    return false;
  }

  /** Drop every unspent state: this provider accepts no further callback. */
  closeStates(): void { this.pendingStates.clear(); }

  /** The stored grant with this flow's staged writes on top. Read fresh each
   *  time so a long-lived provider (the refresh path) never serves a token
   *  another flow has since replaced. */
  private view(): StoredGrant {
    const stored = this.opts.store.readSecret();
    const base: StoredGrant = stored ?? {
      tokens: { access_token: "" },
      client: null,
      connectedAt: "",
      scopes: [...this.opts.scopes],
    };
    return { ...base, ...this.staged };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const client = this.view().client;
    if (!client) return undefined;
    // Only a sign-in sends a redirect URI, so only a sign-in can mismatch on
    // one — see the class note for why a refresh must keep this client
    // whatever the studio port is today.
    if (!this.opts.interactive) return client as OAuthClientInformationMixed;
    const uris = client.redirect_uris ?? [];
    return uris.includes(this.opts.redirectUrl)
      ? (client as OAuthClientInformationMixed)
      : undefined;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.staged.client = client as StoredGrant["client"];
  }

  tokens(): OAuthTokens | undefined {
    // An interactive start reports no tokens even when a grant exists, so
    // `auth()` authorizes rather than refreshing — see the class note.
    if (this.opts.interactive) return undefined;
    const t = this.view().tokens;
    if (!t.access_token) return undefined;
    return {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      // What the provider actually issued. Hardcoding "bearer" would mislabel
      // a DPoP (or any other) token as one the adapter may send as a bearer.
      token_type: t.token_type ?? "bearer",
      expires_in: t.expires_at != null
        ? Math.max(0, Math.floor((t.expires_at - Date.now()) / 1000))
        : undefined,
      scope: t.scope,
    };
  }

  /** The one write. Everything staged lands with the tokens, except the PKCE
   *  verifier — it is spent by the exchange that just happened, and a spent
   *  secret on disk is a secret with no upside. */
  saveTokens(t: OAuthTokens): void {
    const current = this.view();
    const next: StoredGrant = {
      ...current,
      tokens: {
        access_token: t.access_token,
        refresh_token: t.refresh_token ?? current.tokens.refresh_token,
        token_type: t.token_type,
        scope: t.scope,
        // `!= null`, not truthiness: `expires_in: 0` means "already expired",
        // and reading it as "no expiry" would make a dead token look eternal.
        expires_at: t.expires_in != null ? Date.now() + t.expires_in * 1000 : undefined,
      },
      connectedAt: current.connectedAt || new Date().toISOString(),
      scopes: [...this.opts.scopes],
    };
    delete next.codeVerifier;
    this.opts.store.write(next);
    this.staged = {};
  }

  redirectToAuthorization(url: URL): void { this.opts.onRedirect(url); }

  saveCodeVerifier(verifier: string): void { this.staged.codeVerifier = verifier; }

  codeVerifier(): string {
    const v = this.view().codeVerifier;
    if (!v) throw new Error("no PKCE verifier for this sign-in — start the sign-in again");
    return v;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "tokens") {
      // A grant whose token the provider has rejected is not a grant: the
      // store answers "connected" from the file's existence, so leaving a
      // token-less one behind would read as connected forever.
      //
      // `"revoked"`, and that word is load-bearing. The SDK reaches this only
      // from `auth()`'s recovery branches — an `InvalidGrantError` (the
      // refresh token was rejected) or an `InvalidClientError` — so by the
      // time it fires the token is dead AND a refresh could not save it.
      // Clearing is right; going quiet about it is not. The marker is what
      // lets `status()` say "libi's connection was revoked" afterwards
      // instead of offering a first-time Connect, and it holds a timestamp
      // and nothing else — never a byte of the grant being deleted.
      //
      // What must NOT reach here is a SCOPE failure. A 403 never enters the
      // SDK's auth machinery at all (`mcp-client.ts#stripScopeChallenge`),
      // because upscoping presented this refresh token for a grant the user
      // never approved that widely, the provider answered `invalid_grant`,
      // and one ads read the token was never scoped for deleted a live user's
      // entire sign-in.
      this.staged = {};
      // And not on an INTERACTIVE instance. `tokens()` twelve lines up already
      // reports none while interactive, so the grant on disk is not what this
      // sign-in was using — it is the STILL-VALID one the user is re-connecting
      // on top of. A re-connect that dies on a stale consent code, or on
      // `invalid_client` during registration, reaches here too, and clearing
      // then deletes a working grant and tells the user it was revoked: the
      // same class of harm as the 403 above, from the other direction. A
      // failed sign-in leaves the old grant exactly as it was; the user's
      // next attempt replaces it through `saveTokens`.
      if (!this.opts.interactive) this.opts.store.clear("revoked");
      return;
    }
    if (scope === "verifier") { delete this.staged.codeVerifier; return; }
    if (scope === "client") {
      this.staged.client = null;
      const stored = this.opts.store.readSecret();
      if (stored?.client) this.opts.store.write({ ...stored, client: null });
    }
    // "discovery": libi persists no discovery state, so there is none to drop.
  }
}
