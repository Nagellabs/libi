import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { findSocialProvider, type SocialProviderId } from "@/lib/social/catalog";
import { SocialTokenStore } from "@/lib/social/token-store";
import { serverLogger as logger } from "@/lib/logger";
import { LibiOAuthClientProvider } from "./client-provider";

/**
 * libi's own browser sign-in for a social provider — the one place libi
 * obtains a provider credential (AGENTS.md → "libi never stores a provider API
 * key", and its single exception).
 *
 * The "loopback listener" is the studio server itself: the redirect lands on
 * `/api/social/oauth/callback` on 127.0.0.1 at the port the studio is already
 * serving, so no second port is ever bound and there is no socket to leak. What
 * takes the place of closing a listener is the pending entry below — until it
 * is dropped, a callback carrying its state is accepted. It is dropped on
 * success, on failure, on an explicit cancel, and on the TTL; after that the
 * callback route can do nothing at all.
 */
export function redirectUrlFor(studioPort: number): string {
  return `http://127.0.0.1:${studioPort}/api/social/oauth/callback`;
}

/** How long a started sign-in stays answerable. Long enough for a real sign-in
 *  (the provider's own login, MFA, a consent screen), short enough that a tab
 *  the user abandoned stops being a live callback by the end of a coffee. */
export const PENDING_SIGN_IN_TTL_MS = 10 * 60 * 1000;

interface PendingSignIn {
  providerId: SocialProviderId;
  provider: LibiOAuthClientProvider;
  expiry: ReturnType<typeof setTimeout>;
}

/**
 * Keyed by the state in the authorization URL, so two sign-ins running at once
 * are two entries with two providers — neither can answer the other's
 * callback, and neither holds the other's PKCE verifier.
 *
 * On `globalThis`, NOT a module-level `const`. The two halves of a sign-in are
 * two different route modules (`start` and `callback`), and only a production
 * bundle guarantees they share one instance of this one: under `next dev` /
 * Turbopack a route handler is evaluated per route and re-evaluated on edit, so
 * a module-level map would leave the callback looking into an empty one and
 * every sign-in in dev failing as "unknown or already-used state" — a symptom
 * that reads like a state bug rather than a bundling artefact. Same reason and
 * same shape as `lib/terminal/instance.ts`, `lib/social/secret-cipher.ts` and
 * the SessionManager singleton.
 */
const g = globalThis as unknown as { __libiSocialPendingSignIns?: Map<string, PendingSignIn> };
const pending: Map<string, PendingSignIn> = (g.__libiSocialPendingSignIns ??= new Map());

/**
 * States whose sign-in window ran out, so the callback can say WHICH refusal
 * it is. The callback page used to answer an expired window with the same
 * "Sign-in failed. Go back to libi and try Connect again" as a forged or
 * replayed state, although the server knew perfectly well what had happened
 * (QA 2026-09-21, finding 11) — and "failed" sends a user looking for a fault
 * that isn't there.
 *
 * A spent state, not a secret: it is remembered only AFTER it has stopped
 * being usable, is dropped the first time it is presented, and is never
 * logged or rendered. Bounded, and oldest-first (insertion order), so an
 * unattended studio cannot accumulate them.
 */
const EXPIRED_STATES_MAX = 20;
const gx = globalThis as unknown as { __libiSocialExpiredSignIns?: Set<string> };
const expiredStates: Set<string> = (gx.__libiSocialExpiredSignIns ??= new Set());

function rememberExpired(state: string): void {
  expiredStates.add(state);
  for (const oldest of expiredStates) {
    if (expiredStates.size <= EXPIRED_STATES_MAX) break;
    expiredStates.delete(oldest);
  }
}

/** A sign-in that was never completed inside `PENDING_SIGN_IN_TTL_MS`. Its own
 *  error class so the callback route can answer it in the user's terms —
 *  nothing here is a fault, and nothing was stored. */
export class SignInWindowExpiredError extends Error {
  readonly code = "expired";
  constructor() {
    super("the sign-in window expired");
    this.name = "SignInWindowExpiredError";
  }
}

export function __resetOAuthFlowForTests(): void {
  for (const state of [...pending.keys()]) abandon(state);
  expiredStates.clear();
}

/** Take the entry out of the map and stop its timer. After this, a callback
 *  carrying `state` has nothing to land on. */
function drop(state: string): PendingSignIn | undefined {
  const entry = pending.get(state);
  if (!entry) return undefined;
  clearTimeout(entry.expiry);
  pending.delete(state);
  return entry;
}

/** `drop`, plus retiring the provider's own unspent states — the end of a
 *  sign-in that will never complete. `finishSignIn` must NOT use this: it
 *  still has to spend the state it was handed. */
function abandon(state: string): PendingSignIn | undefined {
  const entry = drop(state);
  entry?.provider.closeStates();
  return entry;
}

/**
 * `interactive` defaults to FALSE — a provider built for the refresh path (or
 * any other background use of the stored grant), which keeps the registered
 * client whatever the studio port is today and reports the tokens it holds.
 * Only `startSignIn` passes `true`. Getting this backwards is not a visible
 * failure: it silently costs the user their sign-in on the next relaunch
 * (`client-provider.ts`, class note).
 */
export function providerFor(
  providerId: SocialProviderId,
  studioPort: number,
  opts: { interactive?: boolean; onRedirect?: (url: URL) => void } = {},
): LibiOAuthClientProvider {
  const def = findSocialProvider(providerId);
  return new LibiOAuthClientProvider({
    providerId,
    store: new SocialTokenStore(providerId),
    redirectUrl: redirectUrlFor(studioPort),
    scopes: def.scopes,
    onRedirect: opts.onRedirect ?? (() => {}),
    interactive: opts.interactive ?? false,
  });
}

/** Runs discovery + registration + PKCE up to the redirect; returns the URL for
 *  the page to open. Nothing is stored yet — see the client provider. */
export async function startSignIn(
  providerId: SocialProviderId,
  studioPort: number,
): Promise<{ url: string; state: string }> {
  const def = findSocialProvider(providerId);
  let captured: URL | undefined;
  const provider = providerFor(providerId, studioPort, {
    interactive: true,
    onRedirect: (url) => { captured = url; },
  });

  const result = await auth(provider, { serverUrl: def.mcpUrl, scope: def.scopes.join(" ") });
  if (result !== "REDIRECT" || !captured) {
    throw new Error(`sign-in did not produce an authorization URL (${result})`);
  }
  const state = captured.searchParams.get("state");
  if (!state) throw new Error("authorization URL carries no state");

  const expiry = setTimeout(() => {
    abandon(state);
    rememberExpired(state);
    logger.info({ tag: "social", op: "oauth.expired", providerId }, "sign-in window closed unused");
  }, PENDING_SIGN_IN_TTL_MS);
  expiry.unref();
  pending.set(state, { providerId, provider, expiry });

  logger.info(
    { tag: "social", op: "oauth.start", providerId, port: studioPort, pending: pending.size },
    "sign-in started",
  );
  return { url: captured.toString(), state };
}

/**
 * The callback's half. The state is verified BEFORE the code is used: an
 * unknown, expired or already-spent state never reaches the token endpoint.
 * A failure here leaves nothing behind — the entry is already out of the map,
 * and the provider writes only on a completed exchange.
 */
export async function finishSignIn(
  params: { code: string; state: string },
): Promise<{ providerId: SocialProviderId }> {
  const entry = drop(params.state);
  if (!entry) {
    // Expired is a DIFFERENT answer from unknown, and the only one libi can
    // explain to the user. Spent on the way past, so a replay of the same
    // state afterwards is back to the generic refusal.
    if (expiredStates.delete(params.state)) throw new SignInWindowExpiredError();
    throw new Error("unknown or already-used state");
  }
  if (!entry.provider.consumeState(params.state)) {
    throw new Error("unknown or already-used state");
  }
  const def = findSocialProvider(entry.providerId);
  const result = await auth(entry.provider, {
    serverUrl: def.mcpUrl,
    authorizationCode: params.code,
    scope: def.scopes.join(" "),
  });
  if (result !== "AUTHORIZED") throw new Error(`token exchange did not authorize (${result})`);
  logger.info(
    { tag: "social", op: "oauth.finish", providerId: entry.providerId },
    "sign-in finished",
  );
  return { providerId: entry.providerId };
}

/** The user said no at the provider (or the callback arrived unusable). Shut
 *  the window now rather than leaving it open for its full TTL. */
export function cancelSignIn(state: string | null): void {
  if (!state) return;
  const entry = abandon(state);
  if (!entry) return;
  logger.info(
    { tag: "social", op: "oauth.cancelled", providerId: entry.providerId },
    "sign-in cancelled before it completed",
  );
}

export function disconnect(providerId: SocialProviderId): void {
  // `"disconnected"`, never `"revoked"`: the user asked for this. Marking it
  // revoked would greet them with "libi's connection was revoked" on a page
  // they had just deliberately disconnected.
  new SocialTokenStore(providerId).clear("disconnected");
  logger.info({ tag: "social", op: "oauth.disconnect", providerId }, "grant removed locally");
}
