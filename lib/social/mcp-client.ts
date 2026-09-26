import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SocialError, errShape } from "@/lib/social/errors";
import { parsePythonLiteral } from "@/lib/social/python-literal";
import { serverLogger as logger } from "@/lib/logger";

/**
 * libi as an MCP **client** of a provider's own hosted server. This is the
 * whole transport layer for the social feature: libi maintains no REST client
 * for the provider and vendors none of its types, so when the provider changes
 * its API its TOOL LIST changes with it and `providers/<id>/ops.ts` re-resolves
 * at runtime instead of a pinned guess going stale.
 *
 * Nothing here is reachable by an agent — this connection is libi's own UI
 * talking to the provider under the user's grant.
 */
export interface ProviderMcp {
  listToolNames(): Promise<string[]>;
  /**
   * Calls `name` directly when the server lists it, else through the server's
   * generic `call_tool` (which is how the generated long tail is reached).
   * Returns the PARSED PAYLOAD — `structuredContent` when present, else the
   * first text block — with fastmcp's `{ result: "…" }` wrapper removed and
   * the Python-repr string inside it read (`parseZernioPayload`). Throws
   * `SocialError`, never a raw transport error and never a blank entity.
   */
  call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export interface ConnectOpts {
  url: string;
  /** The Task 6 client provider. Authorization goes through it; this module
   *  never reads the grant and never sees a token. */
  authProvider?: OAuthClientProvider;
  /** Test mode only: a fixed bearer for the local fake. Never a real key. */
  bearer?: string;
  clientName?: string;
  /** Tests: an already-built transport (InMemoryTransport) instead of HTTP. */
  transport?: Transport;
  /** Tests: the fetch the HTTP transport builds on. Production uses global `fetch`. */
  fetch?: FetchLike;
}

/**
 * Per-call ceilings, because the SDK's flat 60 s applies to everything: a
 * `tools/list` that has not answered in 20 s is not going to, while a presign
 * handshake or a post creation (the provider uploads to the platform inside
 * the call) legitimately runs longer than a minute.
 */
export const CALL_TIMEOUT_MS = 20_000;
export const SLOW_CALL_TIMEOUT_MS = 180_000;

/**
 * Matched on underscore SEGMENTS, never a substring, and on the INNER tool
 * name even when the call is routed through `call_tool` — a rename that keeps
 * the segments keeps the ceiling.
 */
export function timeoutForTool(name: string): number {
  const segments = name.toLowerCase().split("_");
  const media = segments[0] === "media" || segments.includes("presigned") || segments.includes("presign") || segments.includes("upload");
  const writesAPost = segments[0] === "posts" && ["create", "publish", "retry", "cross"].some((v) => segments.includes(v));
  return media || writesAPost ? SLOW_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS;
}

/**
 * The name of the provider's generic dispatch tool. An unlisted tool name is
 * routed through it rather than failing, because the hosted server advertises
 * a curated subset and exposes the rest this way.
 */
export const CALL_TOOL = "call_tool";

/**
 * Anything that looks like a credential, removed before a provider string can
 * reach a log line, a SocialError message or an API response.
 *
 * This is not belt-and-braces. The SDK builds `Error POSTing to endpoint:
 * ${text}` out of the RESPONSE BODY (client/streamableHttp.js), and
 * `parseErrorResponse` (client/auth.js) builds `… Raw body: ${body}` out of a
 * token-endpoint body — and the request that provoked that one carried the
 * authorization code and the PKCE verifier. A provider that echoes the request
 * would put both into whatever we do with the message. pino's key-based
 * `redact` cannot reach inside a string; dropping the bytes is what does.
 *
 * `errShape` (errors.ts) is still the rule for LOGGING an error — name and
 * code only, never the message. This function is for the one place a message
 * has to survive: the human-readable half of a `SocialError` the UI shows.
 *
 * It is a net over the shapes a credential is KNOWN to arrive in, not a proof
 * that none survives: a provider that invents a new key name, or splits a
 * secret across lines, gets through. Treat it as the last line of defence
 * behind "never put a provider message anywhere it is not needed", never as
 * licence to pass one somewhere it did not belong.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // "Bearer eyJ…", "Basic abc…", "DPoP …"
  /\b(?:bearer|basic|dpop)\s+[\w.~+/=-]{8,}/gi,
  // A JWT anywhere, in a header or a body.
  /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/g,
  // "access_token": "…", code_verifier=…, client_secret: …, "token": …,
  // secret=…. `[\w-]*(?:token|secret|password)` covers the key names nobody
  // has invented yet; a 3-char value such as a status code is below the {4,}
  // floor. The bare OAuth `code` is deliberately NOT in this alternation —
  // see the two patterns below, which redact it by syntax instead.
  /\b(?:[\w-]*(?:token|secret|password)|api[_-]?key|code_verifier|client_id|authorization)\b["']?\s*[:=]\s*["']?[\w.~+/=-]{4,}/gi,
  // The bare OAuth authorization `code`, matched by SYNTAX rather than value:
  // `code=…` in a URL or query string — exactly what the PKCE redirect and
  // token exchange carry it in.
  /\bcode=[\w.~+/=-]{4,}/gi,
  // …or `"code":"…"` in a JSON body — the other shape the exchange sends it
  // in. Provider PROSE writes a reason code as `(code: some_identifier)`:
  // unquoted key, colon-SPACE, no quotes around the value — indistinguishable
  // from an authorization code by VALUE alone (Zernio's own ads-unavailable
  // message carries exactly this shape, `(code: linked_account_required)`,
  // and must reach the UI verbatim). Only the two quoted/`=` forms above are
  // credential-shaped; the colon-space prose form is left alone on purpose.
  /"code"\s*:\s*"[\w.~+/=-]{4,}"/gi,
];

/** Keeps one provider string from becoming a wall of log. */
const MAX_MESSAGE_CHARS = 500;

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out.length > MAX_MESSAGE_CHARS ? `${out.slice(0, MAX_MESSAGE_CHARS)}…` : out;
}

/** A `Retry-After` value — delta-seconds or an HTTP-date — as an ISO moment. */
export function retryAtFromHeader(value: string | null | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return new Date(Date.now() + seconds * 1000).toISOString();
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return new Date(at).toISOString();
  return undefined;
}

/**
 * The moment to retry at, or NOTHING.
 *
 * There used to be a 60 s default here. It was a fabrication handed to the
 * caller as a fact the provider had stated — and paired with the old loose
 * status regex it put a confident "wait 60 s" on prose that was never a rate
 * limit at all. A caller told nothing was read can back off however it likes;
 * one told 60 s cannot tell the difference.
 */
function retryAtFrom(msg: string, header?: string | null): string | undefined {
  const inText = /retry[-_ ]?after["']?\s*[:=]\s*["']?([^"',}\n]+)/i.exec(msg)?.[1];
  // The text value is what the provider wrote about THIS failure; the header
  // is the transport's own, observed on the 429 response itself.
  return retryAtFromHeader(inText) ?? retryAtFromHeader(header);
}

/** A stashed header older than this belongs to some other request. */
const RETRY_AFTER_TTL_MS = 10_000;

/**
 * Wraps a `fetch` so the `Retry-After` of the last 429 it saw can be read back.
 *
 * This is the only way to honour a real one: the SDK surfaces a status code on
 * `StreamableHTTPError` and nothing else, and `requestInit` is a plain
 * `RequestInit` — it cannot observe a RESPONSE. SDK 1.29 takes a first-class
 * `fetch?: FetchLike` on the transport, which can.
 */
export function observeRetryAfter(base: FetchLike): { fetch: FetchLike; take(): string | null } {
  let seen: { header: string; at: number } | null = null;
  return {
    fetch: async (url, init) => {
      const res = await base(url, init);
      if (res.status === 429) {
        const header = res.headers.get("retry-after");
        seen = header ? { header, at: Date.now() } : null;
      }
      return res;
    },
    take() {
      const held = seen;
      seen = null;
      return held && Date.now() - held.at < RETRY_AFTER_TTL_MS ? held.header : null;
    },
  };
}

/**
 * Keeps a 403 out of the SDK's auth machinery — the single change that stops a
 * SCOPE gap from deleting the user's sign-in.
 *
 * `StreamableHTTPClientTransport` treats a 403 whose `WWW-Authenticate` names
 * `error="insufficient_scope"` as an invitation to UPSCOPE: it re-runs `auth()`
 * asking for the wider scope, which presents the refresh token for a grant the
 * user never approved that widely. The provider says `invalid_grant`, the SDK
 * classifies that as a recoverable auth failure and calls
 * `invalidateCredentials("tokens")` — which is `store.clear()`, the whole grant
 * off disk. That is what happened to a live account: an ads read the token was
 * never scoped for (libi asks for NO ads scope, catalog.ts `OAUTH_SCOPES`)
 * silently signed the user out of everything.
 *
 * Upscoping could never have worked here anyway. The provider libi hands the
 * transport is the NON-INTERACTIVE one, whose `redirectToAuthorization` only
 * captures the URL — so `auth()` can return `REDIRECT`, never `AUTHORIZED`,
 * and a wider grant only ever comes from a browser sign-in the user completes.
 * The branch had no upside and one very large downside.
 *
 * So the challenge header is dropped on a 403 and the SDK falls through to
 * `throw new StreamableHTTPError(403, …)`, which `toSocialError` classifies as
 * `forbidden`. A 401 is untouched: that one IS about the token, and refreshing
 * it there is exactly right.
 */
export function stripScopeChallenge(base: FetchLike): FetchLike {
  return async (url, init) => {
    const res = await base(url, init);
    if (res.status !== 403 || !res.headers.has("www-authenticate")) return res;
    const headers = new Headers(res.headers);
    headers.delete("www-authenticate");
    // The body is untouched and still unread — the SDK reads it itself to build
    // the error text — so it is handed straight to the new Response.
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

/**
 * A status code must be INTRODUCED by something status-ish to count. A bare
 * `\b(4\d\d|5\d\d)\b` over prose is a liability: "caption exceeds the 429
 * character limit" became a rate limit (with an invented 60 s wait), and "must
 * be under 500 characters" became a retryable server error.
 */
const STATUS_IN_TEXT = /(?:\bHTTP\b|\bstatus\b|\bcode\b|^Error:)\D{0,12}(401|403|404|409|422|429|5\d\d)\b/i;

/**
 * The provider reports failure three ways and this is the one funnel for all
 * of them: an SDK auth error, a transport error carrying the HTTP status, or a
 * tool result with `isError` whose text reads "HTTP 429 …" / "Error: 401 …" /
 * `{"error":…,"status":…}`. A 401 must land on `unauthorized` specifically —
 * the UI branches on it to offer reconnect rather than showing a failure.
 */
export function toSocialError(err: unknown, retryAfterHeader?: string | null): SocialError {
  if (err instanceof SocialError) return err;
  // Reachable only from the 401 path now that `stripScopeChallenge` keeps a
  // 403 out of `auth()`: the SDK raises this when a re-authorization it ran
  // for a REJECTED TOKEN could not complete in the background. That is the
  // genuine "the grant is dead" signal, and the only one.
  if (err instanceof UnauthorizedError) {
    return new SocialError("unauthorized", "the provider no longer accepts libi's sign-in", { status: 401 });
  }
  const msg = redactSecrets(err instanceof Error ? err.message : String(err));
  // The transport knows the real status; the regex is only for a status the
  // provider wrote into a tool's error TEXT, where nothing structured exists.
  const fromTransport = err instanceof StreamableHTTPError && typeof err.code === "number" && err.code > 0 ? err.code : 0;
  const status = fromTransport || Number(STATUS_IN_TEXT.exec(msg)?.[1] ?? 0);
  // 401 and 403 are DIFFERENT answers and libi must not merge them. Per RFC
  // 6750 a token that is missing, expired or revoked is a 401; a 403 says the
  // token is understood and simply does not carry this permission. Merging
  // them is what turned one ads read into a sign-out: `unauthorized` is the
  // kind `withAdapter` escalates to `markUnauthorized()`. A 403 leaves the
  // grant and the connection exactly where they were.
  if (status === 401) return new SocialError("unauthorized", msg, { status });
  if (status === 403) return new SocialError("forbidden", msg, { status });
  if (status === 429) return new SocialError("rate_limited", msg, { status, retryAt: retryAtFrom(msg, retryAfterHeader) });
  if (status === 404) return new SocialError("not_found", msg, { status });
  if (status === 409) return new SocialError("duplicate", msg, { status });
  if (status === 422) return new SocialError("validation", msg, { status });
  return new SocialError("provider", msg, { status: status || undefined });
}

interface RawToolResult {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/**
 * The fastmcp envelope. Every generated Zernio tool declares
 * `outputSchema: { result: string }` with `x-fastmcp-wrap-result` (verified
 * live, 2026-09-20), so the payload arrives wrapped one level deep in a
 * single `result` key. Only that exact shape is unwrapped — an answer that
 * happens to carry a `result` field of its own alongside others is left
 * alone.
 */
function unwrapWrappedResult(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const keys = Object.keys(raw as Record<string, unknown>);
  return keys.length === 1 && keys[0] === "result" ? (raw as { result: unknown }).result : raw;
}

/**
 * Zernio's own error convention (`.superpowers/sdd/zernio-live-shapes.md` →
 * "Tool-call mechanics"): a failure — whether from a tool called directly or
 * one reached through `call_tool` — comes back as ordinary text reading
 * `Error: [<status>] <message> (code: <code>)`. Verified live 2026-09-20 on
 * `ad_accounts_list_ad_accounts` for an Instagram account with no linked
 * Facebook: the wrapped payload is `{"result": "Error: [422] A connected
 * Facebook account is required to manage Instagram ads. (code:
 * linked_account_required)"}` — an ordinary, non-`isError` result, because
 * `call_tool` relays the underlying tool's own failure as its OWN successful
 * answer text rather than raising. A string shaped like this is a FAILURE,
 * not a payload libi merely could not parse; reading it as the latter threw
 * the generic "answered in a format libi cannot read" and discarded the
 * provider's own message — which for the ads tab replaced "a connected
 * Facebook account is required" with an unclassified `provider` error
 * (502'ing the whole tab, since only `validation` / `not_found` route to
 * `AdsRead.unavailable` — `zernio/adapter.ts#ADS_UNAVAILABLE_KINDS`).
 */
const ZERNIO_ERROR_TEXT = /^Error:\s*\[\d+\]/;

/** JSON first, then a Python literal; a string that is neither is not a payload. */
function parsePayloadString(text: string, name: string): unknown {
  if (ZERNIO_ERROR_TEXT.test(text.trim())) throw toSocialError(new Error(text));
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON — which is the NORMAL case for Zernio.
  }
  try {
    return parsePythonLiteral(text);
  } catch {
    // Never the text itself in the message: a payload carries user captions,
    // and an error message travels further than a payload does.
    throw new SocialError("provider", `${name} answered in a format libi cannot read`);
  }
}

/**
 * ONE seam turns a provider tool result into a payload, and it is the reason
 * the rest of the feature can trust what it normalizes.
 *
 * Zernio's answers arrive as `{ "result": "<Python repr>" }`: the fastmcp
 * wrapper around a string the server produced with Python's own `str()`, so
 * it uses single quotes and `None` / `True` / `False`. `JSON.parse` fails on
 * that. Before this existed the failure was SILENT — the adapter found no
 * `post` / `accounts` key on the wrapper, fell through to it, and coerced it
 * to `{}` / `[]`, so `listAccounts()` answered `[]` and `createPost()`
 * answered a blank post with `deduped: false`.
 *
 * A string that parses as NEITHER JSON nor a Python literal throws
 * `SocialError("provider")`. That is the point of the function: a prose
 * answer is not a payload, and returning `{ text }` for one only moves the
 * blank entity a step further in. The prose-flattening convenience tools are
 * denied at the resolver (`ZERNIO_LOSSY_TOOLS`) precisely so this never fires
 * for a tool libi means to use.
 */
export function parseZernioPayload(raw: unknown, name: string): unknown {
  const value = typeof raw === "string" ? parsePayloadString(raw, name) : raw;
  const inner = unwrapWrappedResult(value);
  if (inner === value) return value;
  return typeof inner === "string" ? parsePayloadString(inner, name) : inner;
}

function parseResult(name: string, res: RawToolResult): unknown {
  const text = res.content?.find((c) => c.type === "text")?.text ?? "";
  if (res.isError) throw toSocialError(new Error(text || `${name} failed`));
  if (res.structuredContent !== undefined) return parseZernioPayload(res.structuredContent, name);
  if (!text) return null;
  return parseZernioPayload(text, name);
}

export async function connectProviderMcp(opts: ConnectOpts): Promise<ProviderMcp> {
  const client = new Client({ name: opts.clientName ?? "libi", version: "0.1" }, { capabilities: {} });
  // Only the HTTP transport has a fetch to observe; a test transport has none,
  // and `take()` then simply always answers null.
  const retryAfter = observeRetryAfter(stripScopeChallenge(opts.fetch ?? ((url, init) => fetch(url, init))));
  const transport =
    opts.transport ??
    new StreamableHTTPClientTransport(new URL(opts.url), {
      authProvider: opts.authProvider,
      requestInit: opts.bearer ? { headers: { Authorization: `Bearer ${opts.bearer}` } } : undefined,
      fetch: retryAfter.fetch,
    });
  try {
    await client.connect(transport);
  } catch (err) {
    const e = toSocialError(err, retryAfter.take());
    logger.warn({ tag: "social", op: "mcp.connect_failed", kind: e.kind, status: e.status, ...errShape(err) }, "provider MCP connect failed");
    // The transport owns a fetch/SSE stream even when connect throws partway.
    await client.close().catch(() => {});
    throw e;
  }

  /**
   * Memoized as a PROMISE, not a value: two concurrent `call`s would otherwise
   * both find the cache empty and issue their own `tools/list`. A failure
   * clears it so the next call retries rather than caching the error.
   */
  let namesPromise: Promise<string[]> | null = null;
  const listToolNames = (): Promise<string[]> => {
    if (!namesPromise) {
      namesPromise = client
        .listTools(undefined, { timeout: CALL_TIMEOUT_MS })
        .then((r) => r.tools.map((t) => t.name))
        .catch((err) => {
          namesPromise = null;
          throw toSocialError(err, retryAfter.take());
        });
    }
    return namesPromise;
  };

  /**
   * The provider reports an EXPIRED ACCESS TOKEN two different ways, and only
   * one of them is a 401 anything in the SDK can see.
   *
   * ESTABLISHING the MCP session is gated at the HTTP layer, so a `connect()`
   * carrying a stale token gets a real 401 and
   * `StreamableHTTPClientTransport#send` runs `auth()` itself — which refreshes,
   * writes the new grant through the provider and re-sends. That path works.
   * It is the whole reason restarting the server "fixed" this, and why the
   * grant file was rewritten the moment it came back up.
   *
   * A TOOL CALL on an ALREADY-ESTABLISHED session does not go that way. The
   * provider answers **HTTP 200** and relays its upstream API's own words as
   * the result TEXT — `Error: [401] Unauthorized` — which `parsePayloadString`
   * correctly reads as a failure and `toSocialError` correctly classifies as
   * `unauthorized`. No HTTP 401 ever exists, so no branch of the SDK is
   * reached and no refresh is ever attempted. Measured live on 2026-09-21,
   * one hour after `connectedAt` (the access token's whole lifetime), with the
   * grant file byte-identical across the entire unauthorized window and
   * `errName: "SocialError"` on every `mcp.call_failed`, which is what says
   * the 401 was minted from text rather than seen on the wire.
   *
   * So libi runs the same `auth()` the transport would have, and retries the
   * call once. Three properties hold it together:
   *
   * - It is a REFRESH and only a refresh. The provider handed in here is the
   *   NON-INTERACTIVE one, whose `redirectToAuthorization` merely captures a
   *   URL nobody opens, so `auth()` answers `AUTHORIZED` (the refresh worked)
   *   or `REDIRECT` (it did not, and only a browser sign-in will). This module
   *   still never reads the grant and never sees a token — `auth()` writes
   *   through the provider, and `_commonHeaders()` re-reads `tokens()` on every
   *   request, so the retry carries the new one with nothing cached to clear.
   * - A DEAD refresh token still ends the connection exactly as before: the
   *   token endpoint answers `invalid_grant`, `auth()`'s own recovery calls
   *   `invalidateCredentials("tokens")` → `store.clear("revoked")`, the
   *   follow-up returns `REDIRECT`, and the original `unauthorized` travels on
   *   to `withAdapter` → `markUnauthorized()`. Grant cleared, revoked marker
   *   written, `needsReconnect` reported.
   * - A 403 NEVER arrives here. `toSocialError` keeps it `forbidden`, and
   *   `stripScopeChallenge` keeps it out of the SDK's auth machinery. Nothing
   *   below widens that — the branch keys on the `unauthorized` kind alone.
   */
  let refreshes = 0;
  let refreshing: Promise<boolean> | null = null;

  const runRefresh = async (provider: OAuthClientProvider): Promise<boolean> => {
    try {
      // No `scope`: `authInternal` falls back to `provider.clientMetadata.scope`,
      // which is what libi asked for in the first place. Passing a wider one
      // here is how a refresh turns into the upscope that deletes a grant.
      //
      // `fetchFn` is the transport's own fetch, exactly as the SDK passes it
      // to the `auth()` it runs itself: the same 403-challenge stripping and
      // the same `Retry-After` observation apply to discovery and to the token
      // endpoint, and a test can inject one place instead of two.
      const result = await auth(provider, { serverUrl: opts.url, fetchFn: retryAfter.fetch });
      if (result !== "AUTHORIZED") {
        logger.warn({ tag: "social", op: "mcp.refresh_exhausted" }, "the stored grant could not be refreshed; a sign-in is required");
        return false;
      }
      refreshes += 1;
      logger.info({ tag: "social", op: "mcp.refreshed" }, "refreshed libi's own grant after the provider rejected it");
      return true;
    } catch (err) {
      logger.warn({ tag: "social", op: "mcp.refresh_failed", ...errShape(err) }, "refreshing libi's own grant failed");
      return false;
    }
  };

  /**
   * One refresh at a time, and none at all for a caller whose 401 predates a
   * refresh that has already landed. An expiry hits every in-flight request at
   * once (twelve of them, in the live measurement), and N parallel refreshes
   * of one grant is how a provider that rotates refresh tokens ends up
   * rejecting its own — `invalid_grant`, which clears the grant for real.
   */
  const refreshGrant = (seen: number): Promise<boolean> => {
    const provider = opts.authProvider;
    if (!provider) return Promise.resolve(false);
    if (refreshes !== seen) return Promise.resolve(true);
    if (!refreshing) {
      const run = runRefresh(provider).finally(() => {
        if (refreshing === run) refreshing = null;
      });
      refreshing = run;
    }
    return refreshing;
  };

  const invoke = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const listed = (await listToolNames()).includes(name);
    const startedAt = Date.now();
    // Always the INNER name's ceiling: routing through `call_tool` does not
    // make a presign any faster.
    const options = { timeout: timeoutForTool(name) };
    try {
      const res = listed
        ? await client.callTool({ name, arguments: args }, undefined, options)
        : await client.callTool({ name: CALL_TOOL, arguments: { name, arguments: args } }, undefined, options);
      logger.debug(
        { tag: "social", op: "mcp.call", tool: name, via: listed ? "direct" : CALL_TOOL, ms: Date.now() - startedAt },
        "provider tool called",
      );
      return parseResult(name, res as RawToolResult) as T;
    } catch (err) {
      const e = toSocialError(err, retryAfter.take());
      // Never `e.message` here, redacted or not — errors.ts → errShape.
      logger.warn(
        { tag: "social", op: "mcp.call_failed", tool: name, via: listed ? "direct" : CALL_TOOL, kind: e.kind, status: e.status, ...errShape(err) },
        "provider tool failed",
      );
      throw e;
    }
  };

  return {
    listToolNames,
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const seen = refreshes;
      try {
        return await invoke<T>(name, args);
      } catch (err) {
        if (!(err instanceof SocialError) || err.kind !== "unauthorized") throw err;
        if (!(await refreshGrant(seen))) throw err;
        // ONCE, and outside the `try`, so a second rejection is final.
        //
        // Repeating a CREATE is safe here for the reason a 401 is a 401: the
        // request was not authorized, so it was not performed. This is also
        // exactly what the SDK's own transport already does with an HTTP 401
        // (`send()` re-sends the same JSON-RPC message after `auth()`), so the
        // text-shaped 401 is being made to behave like the wire-shaped one
        // rather than given a new policy of its own. The adapter's republish
        // gate is untouched and still upstream of all of this: if the retry
        // fails too, `createPost` marks the intent unknown and scans exactly
        // as it did before.
        return invoke<T>(name, args);
      }
    },
    async close() {
      namesPromise = null;
      await client.close();
    },
  };
}

/**
 * ONE client per grant. The holder single-flights the connect so N concurrent
 * requests share one client instead of opening N, and both teardowns really
 * close it — the client owns the socket and the SDK's reconnection timers, so
 * dropping the reference without closing would leak both.
 *
 * `close()` and `disconnect()` differ in what comes AFTER, which is the part
 * Task 8 depends on: a reset may reopen on the next request, a disconnect may
 * not, and a call that was in flight across a disconnect must fail terminally
 * rather than as a retryable provider blip.
 */
export interface ProviderMcpHolder {
  get(): Promise<ProviderMcp>;
  /** RESET — drop the client; the next `get()` opens a fresh one. What a
   *  transport reset or a settings change calls. */
  close(): Promise<void>;
  /** TERMINAL — the grant is gone (the user disconnected the provider). Every
   *  later `get()` fails `unauthorized`, and never reopens. */
  disconnect(): Promise<void>;
}

/** Non-retryable by kind: nothing is coming back until the user reconnects. */
function disconnectedError(): SocialError {
  return new SocialError("unauthorized", "the provider is disconnected — reconnect to continue", { status: 401 });
}

export function holdProviderMcp(connect: () => Promise<ProviderMcp>): ProviderMcpHolder {
  let current: Promise<ProviderMcp> | null = null;
  let closed = false;
  const drop = async (): Promise<void> => {
    const held = current;
    current = null;
    if (!held) return;
    // `held` may still be in flight; close what it becomes, and swallow a
    // connect that never succeeded — there is nothing to close in that case.
    await held.then((mcp) => mcp.close()).catch(() => {});
  };
  return {
    get() {
      if (closed) return Promise.reject(disconnectedError());
      if (!current) {
        current = connect().catch((err) => {
          // A failed connect must not be cached as the connection.
          current = null;
          // A connect that lost its race with `disconnect()` is NOT a
          // retryable provider blip — the socket it wanted is gone on purpose.
          // Task 8 branches on that: a reset may reopen, a disconnect may not.
          if (closed) throw disconnectedError();
          throw err;
        });
      }
      return current;
    },
    close: drop,
    async disconnect() {
      closed = true;
      await drop();
    },
  };
}
