import { getSocialSettings } from "@/lib/db/settings";
import { findSocialProvider, type SocialProviderId } from "@/lib/social/catalog";
import type { SocialAdapter } from "@/lib/social/adapter";
import { SocialError, isSocialError } from "@/lib/social/errors";
import { connectProviderMcp, holdProviderMcp, type ProviderMcp, type ProviderMcpHolder } from "@/lib/social/mcp-client";
import { SocialTokenStore, type GrantLocation } from "@/lib/social/token-store";
import { providerFor } from "@/lib/social/oauth/flow";
import { ZernioAdapter } from "@/lib/social/providers/zernio/adapter";
import { isTestMode } from "@/lib/test-mode";
import { getCurrentPort } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";

/**
 * The non-secret view of libi's own connection to a social provider. Every
 * field here is safe to serialize into an API response — there is deliberately
 * no field a token could travel in, and the service reads the grant through
 * `SocialTokenStore#status()` (the non-secret view) rather than `readSecret()`,
 * so it never HOLDS one either. The token reaches the provider only inside the
 * MCP client's OAuth provider.
 */
export interface SocialStatus {
  providerId: SocialProviderId | null;
  connected: boolean;
  needsReconnect: boolean;
  scopes: string[];
  connectedAt?: string;
  /** When the provider MCP last actually answered a connect — not a poll. */
  lastVerifiedAt?: string;
  tokenWhere?: GrantLocation;
  selfCheck?: { ok: boolean; missing: string[] };
}

export interface SocialService {
  status(): Promise<SocialStatus>;
  adapter(): Promise<SocialAdapter>;
  /** The provider rejected the grant (401): stop serving it until a reconnect. */
  markUnauthorized(): void;
  /** The grant CHANGED (a sign-in completed): drop what was held; the next
   *  request may open a fresh connection. */
  reset(): void;
  /** The grant is GONE (the user disconnected): drop what was held, and serve
   *  nothing until a reset. Terminal, so an in-flight call fails as
   *  `unauthorized` instead of a retryable provider blip. */
  disconnect(): void;
}

/** Test mode only, and only when a fake's URL was given: never a real key. */
const TEST_BEARER = "test-mode";
function testModeUrl(): string | null {
  const url = process.env.LIBI_SOCIAL_MCP_URL;
  return isTestMode() && url ? url : null;
}

interface Held {
  providerId: SocialProviderId;
  aiLabelDefault: boolean;
  holder: ProviderMcpHolder;
  adapter: SocialAdapter;
}

/**
 * A `ProviderMcp` that resolves through the holder on every call. The adapter
 * is built ONCE per grant and keeps working across a transport reset, while
 * the holder single-flights the connect so N concurrent requests share one
 * client — and `close()` here is the holder's reset, never a terminal
 * disconnect, which only `disconnect()` below performs.
 */
function viaHolder(holder: ProviderMcpHolder): ProviderMcp {
  return {
    async listToolNames() { return (await holder.get()).listToolNames(); },
    async call<X>(name: string, args: Record<string, unknown>) { return (await holder.get()).call<X>(name, args); },
    async close() { await holder.close(); },
  };
}

function build(): SocialService {
  let held: Held | null = null;
  let unauthorized = false;
  let disconnected = false;
  let lastVerifiedAt: string | undefined;

  const connect = async (providerId: SocialProviderId): Promise<ProviderMcp> => {
    const url = testModeUrl();
    const mcp = url
      ? await connectProviderMcp({ url, bearer: TEST_BEARER })
      : await connectProviderMcp({
          url: findSocialProvider(providerId).mcpUrl,
          // The grant lives behind this provider: the service hands out an
          // adapter, never a token.
          authProvider: providerFor(providerId, getCurrentPort()),
        });
    lastVerifiedAt = new Date().toISOString();
    logger.info({ tag: "social", op: "service.connected", providerId, testMode: !!url }, "provider MCP connected");
    return mcp;
  };

  /** Let go of the client. `terminal` is the user disconnecting — every later
   *  `get()` on that holder fails rather than reopening. */
  const drop = (terminal: boolean): void => {
    const h = held;
    held = null;
    if (!h) return;
    void (terminal ? h.holder.disconnect() : h.holder.close()).catch(() => {});
  };

  /**
   * The grant is no longer readable, and this process is holding a connection
   * opened under it. Let the client go and forget the verification, because
   * both belong to something the user no longer has.
   *
   * Nothing pushes a vanished grant at this service: the SDK's auth recovery
   * clears the file from inside a request, a disconnect can come from another
   * process, and either way the next poll is the first chance to notice. What
   * it must not do is keep answering from what it noticed last time.
   */
  const forgetVanishedGrant = (providerId: SocialProviderId): void => {
    if (!held && lastVerifiedAt === undefined) return;
    drop(false);
    lastVerifiedAt = undefined;
    logger.info(
      { tag: "social", op: "service.grant_vanished", providerId },
      "grant is no longer readable; dropped the connection held for it",
    );
  };

  const status = async (): Promise<SocialStatus> => {
    const { providerId } = getSocialSettings();
    if (!providerId) return { providerId: null, connected: false, needsReconnect: false, scopes: [] };
    // status(), NEVER readSecret(): this service must not hold a token, and a
    // shape that cannot carry one is what guarantees it.
    //
    // It is also the ONLY source of `connected`. Test mode used to be OR-ed in
    // here, which let the answer be `connected: true` with no grant behind it —
    // and it showed: no `connectedAt`, an empty scope list, and a
    // `lastVerifiedAt` left over from a connection to the fake. Test mode now
    // writes a real (test-mode-marked) grant instead, so there is exactly one
    // thing that can make libi connected, and it is a grant on disk.
    const grant = new SocialTokenStore(providerId).status();
    if (!grant.connected) forgetVanishedGrant(providerId);
    return {
      providerId,
      connected: grant.connected && !unauthorized && !disconnected,
      // Two sources, and they cover different halves of the grant's life.
      // With a grant still on disk it is this process's OBSERVED 401. With no
      // grant it is the store's persisted marker — because the grant may have
      // been cleared by the SDK's auth recovery, and then "no file" is all
      // that is left. Reading only the file's absence is what told a user who
      // had just been signed out that they had never connected: one silent
      // sign-out, no explanation, and a "Connect libi" button as if nothing
      // had happened. The marker also survives a restart, which the in-memory
      // flag does not.
      needsReconnect: grant.connected ? unauthorized : grant.revoked,
      scopes: grant.scopes,
      connectedAt: grant.connectedAt,
      lastVerifiedAt,
      tokenWhere: grant.where,
    };
  };

  return {
    status,
    async adapter() {
      const settings = getSocialSettings();
      if (!settings.providerId) throw new SocialError("provider", "no social provider chosen");
      if (disconnected) {
        throw new SocialError("unauthorized", "the provider is disconnected — reconnect to continue", { status: 401 });
      }
      const st = await status();
      if (!st.connected) {
        throw new SocialError("unauthorized", st.needsReconnect ? "libi's connection was revoked" : "libi is not connected", { status: 401 });
      }
      // ONE adapter per connected grant. It is rebuilt when the provider
      // changes, and when the AI-label default does — the adapter captured
      // that value, so a settings change must not keep stamping the old one.
      const aiLabelDefault = settings.defaults.aiLabel;
      if (held && held.providerId === settings.providerId && held.aiLabelDefault === aiLabelDefault) return held.adapter;
      drop(false);
      const providerId = settings.providerId;
      const holder = holdProviderMcp(() => connect(providerId));
      held = { providerId, aiLabelDefault, holder, adapter: new ZernioAdapter(viaHolder(holder), { aiLabelDefault }) };
      return held.adapter;
    },
    markUnauthorized() {
      unauthorized = true;
      drop(false);
      logger.warn({ tag: "social", op: "service.unauthorized" }, "provider rejected libi's grant");
    },
    reset() {
      unauthorized = false;
      disconnected = false;
      drop(false);
      logger.info({ tag: "social", op: "service.reset" }, "provider connection dropped after a grant change");
    },
    disconnect() {
      disconnected = true;
      unauthorized = false;
      drop(true);
      logger.info({ tag: "social", op: "service.disconnected" }, "provider disconnected; connection closed for good");
    },
  };
}

/**
 * On `globalThis`, not a module-level `const`: under `next dev` a route module
 * is evaluated per route and re-evaluated on edit, so a module-level singleton
 * would give each route its own service — and the OAuth callback would reset a
 * different instance than the one the Social page is reading. Same reason and
 * shape as `lib/social/oauth/flow.ts`'s pending map.
 */
const g = globalThis as unknown as { __libiSocialService?: SocialService };

export function getSocialService(): SocialService {
  return (g.__libiSocialService ??= build());
}

export function __setSocialServiceForTests(s: SocialService | null): void {
  if (s) g.__libiSocialService = s;
  else delete g.__libiSocialService;
}

/**
 * Route helper: run one adapter call, and flip the service to
 * needs-reconnect when the provider rejects the grant. The 401 still throws —
 * `socialErrorToResponse` turns it into `{ error: "needs_reconnect" }` — but
 * the next poll of `/api/social/status` now says so too, instead of the UI
 * discovering it one failed action at a time.
 */
export async function withAdapter<X>(fn: (a: SocialAdapter) => Promise<X>): Promise<X> {
  const svc = getSocialService();
  // Resolved OUTSIDE the try on purpose. `adapter()` throws its own 401 when
  // libi is simply NOT CONNECTED (no grant yet) — catching that would call
  // `markUnauthorized()` and flip `status()` to `needsReconnect`, so the UI
  // would tell a user who has never connected that their connection was
  // revoked. Only a 401 the PROVIDER answered is evidence about the grant.
  const adapter = await svc.adapter();
  try {
    return await fn(adapter);
  } catch (e) {
    // `unauthorized` ONLY — never `forbidden`. A 403 is a scope gap on one
    // feature, and tearing the whole provider connection down for it made a
    // single failed ads read cost the user every other tab until the server
    // restarted. The 401 is the only answer that is about the grant.
    if (isSocialError(e) && e.kind === "unauthorized") svc.markUnauthorized();
    throw e;
  }
}
