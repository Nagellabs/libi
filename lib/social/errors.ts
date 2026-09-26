import type { KnownPlatform } from "./catalog";

/**
 * `unsupported` is the STRUCTURAL failure: libi asked for an operation this
 * provider has no tool for (renamed away, or never existed). It is deliberately
 * not `provider` — that kind is retryable, so a misconfiguration would retry
 * forever wearing the costume of a transient upstream blip.
 *
 * `needs_confirmation` is the one kind that is not a failure at all: the
 * operation was REFUSED pending a human decision. It exists for the publish-now
 * republish gate — libi could not establish whether a previous attempt went
 * out, and a second attempt is a thing only the user may ask for.
 *
 * `forbidden` is the SCOPE failure, and it is deliberately NOT `unauthorized`.
 * The grant is live and the provider is answering with it; this one operation
 * is outside what the user approved. libi's `OAUTH_SCOPES` (catalog.ts) asks
 * for no ads scope AT ALL, so an ads read answering `403
 * insufficient_permissions` is the EXPECTED steady state of a healthy grant,
 * not evidence about the token. Reading it as `unauthorized` cost a real user
 * their whole sign-in: the kind is what `withAdapter` branches on to call
 * `markUnauthorized()`, and it is what the SDK's auth machinery treats as
 * "these credentials are bad". One feature is unavailable; nothing needs
 * reconnecting.
 */
export type SocialErrorKind =
  | "unauthorized" | "forbidden" | "rate_limited" | "partial" | "duplicate" | "validation" | "not_found" | "provider"
  | "unsupported" | "needs_confirmation";

export class SocialError extends Error {
  readonly kind: SocialErrorKind;
  readonly status?: number;
  /** ISO time to retry at (from Retry-After) — rate_limited only. */
  readonly retryAt?: string;
  /** 207 partial: which targets failed and why (verbatim provider text). `accountId` lets a
   * platform with several connected accounts be attributed to the one that actually failed. */
  readonly perTarget?: Array<{ platform: KnownPlatform; accountId?: string; error: string }>;
  constructor(kind: SocialErrorKind, message: string, extra: { status?: number; retryAt?: string; perTarget?: SocialError["perTarget"] } = {}) {
    super(message);
    this.name = "SocialError";
    this.kind = kind;
    this.status = extra.status;
    this.retryAt = extra.retryAt;
    this.perTarget = extra.perTarget;
  }
}

/**
 * Whether `err` is a `SocialError`, judged by its name (and a string `kind`). Not `instanceof`:
 * the social service (`getSocialService`, on globalThis) and the adapter it holds were built from
 * whichever route bundle loaded them first, and each Next route bundle has its own copy of this
 * module — so a route's class need not be the one the adapter threw with.
 */
export function isSocialError(err: unknown): err is SocialError {
  return err instanceof Error && err.name === "SocialError" && typeof (err as { kind?: unknown }).kind === "string";
}

/** What a route answers for a SocialError: never the raw provider payload, never a token. */
export function socialErrorToResponse(e: SocialError): { status: number; body: Record<string, unknown> } {
  switch (e.kind) {
    case "unauthorized": return { status: 401, body: { error: "needs_reconnect" } };
    // 403, and NOT `needs_reconnect`: the grant is fine. The message is the
    // provider's own words about which permission is missing, already through
    // `redactSecrets`, and the UI shows it as that feature being unavailable.
    case "forbidden":    return { status: 403, body: { error: "forbidden", message: e.message } };
    case "rate_limited": return { status: 429, body: { error: "rate_limited", retryAt: e.retryAt ?? null } };
    case "not_found":    return { status: 404, body: { error: "not_found" } };
    case "validation":   return { status: 422, body: { error: "validation", message: e.message } };
    // A provider 409 on CREATE is a SUCCESS outcome, not this branch: the
    // adapter's `createPost` catches that 409 itself and returns
    // `{ deduped: true }` (spec appendix) — it never lets the error escape
    // to a route. Reaching this mapping means a genuine duplicate surfaced
    // on a non-create path (e.g. a retry racing another retry).
    case "duplicate":    return { status: 409, body: { error: "duplicate", message: e.message } };
    case "partial":      return { status: 207, body: { error: "partial", perTarget: e.perTarget ?? [] } };
    // 501, not 502: the provider is up and answering — it simply exposes no
    // tool for what libi asked. Retrying cannot change that; a human must.
    case "unsupported":  return { status: 501, body: { error: "unsupported", message: e.message } };
    // 409 because it IS a conflict with a possible existing post. The body
    // key is what the UI branches on to offer "publish again anyway".
    case "needs_confirmation": return { status: 409, body: { error: "confirm_republish", message: e.message } };
    default:             return { status: 502, body: { error: "provider", message: e.message } };
  }
}

/**
 * WHAT was being attempted when the error happened. Retryability is a property
 * of the operation, not of the error alone: the same transport blip is safe to
 * repeat on a read and unsafe to repeat on a publish.
 */
export type SocialOperation =
  | { kind: "read" }
  /** `publishesNow` mirrors `CreatePostInput.when.mode === "now"`. */
  | { kind: "write"; publishesNow: boolean };

/**
 * Whether the same request may be sent again AUTOMATICALLY, with the same
 * `requestId`.
 *
 * The operation comes first. **A write that publishes immediately is never
 * auto-retried**, whatever the error says. The reason is the uncovered window:
 * the request reached Zernio, Zernio published, and the answer never got back
 * to libi — from here that is indistinguishable from a request that never
 * arrived, and Zernio's MCP exposes no idempotency header to settle it
 * (`.superpowers/sdd/zernio-live-shapes.md`). A retry wrapper that treated
 * `provider` as blanket-retryable would post twice. The recovery path for
 * those is the adapter's intent row + recovery scan, and then a HUMAN
 * confirming a second attempt — never a loop.
 *
 * For everything else the old reasoning holds. `rate_limited` (429) is the
 * canonical retry — once `retryAt` passes. `provider` (502, this file's
 * catch-all — an unrecognized or transport-level failure) is Zernio's bucket
 * for "something upstream broke", usually transient; on a draft/schedule write
 * the adapter's intent row makes a repeat safe. Everything else is not
 * retryable: `unauthorized` needs a reconnect, `forbidden` needs a wider grant
 * (a bare retry under the same token is forbidden every time), `partial` needs
 * a per-target retry rather than a blind resend, `unsupported` needs a code
 * change (the tool is gone, not busy), `needs_confirmation` needs the user,
 * and `validation` / `not_found` / `duplicate` will not change on a bare retry.
 *
 * **`op` is REQUIRED, deliberately.** It used to default to `{ kind: "read" }`,
 * which answers `true` for `provider` — so the first caller that wrote the
 * obvious `isRetryable(err)` would have auto-retried a publish that may
 * already have posted. There are no production callers yet; the argument
 * being mandatory is what makes the first one state, at the call site,
 * whether it is about to repeat a write that publishes.
 */
export function isRetryable(e: SocialError, op: SocialOperation): boolean {
  if (op.kind === "write" && op.publishesNow) return false;
  switch (e.kind) {
    case "rate_limited":
    case "provider":
      return true;
    case "unauthorized":
    case "forbidden":
    case "partial":
    case "duplicate":
    case "validation":
    case "not_found":
    case "unsupported":
    case "needs_confirmation":
      return false;
  }
}

/**
 * The ONLY shape an error from this feature may be logged in: `err.name` plus
 * the `code` (an `ErrnoException`'s `EACCES`, or an OAuth error class's own
 * code) — never `err.message`.
 *
 * Two message sources make that absolute rather than stylistic. The token
 * store's messages can quote bytes out of the grant file itself. And the MCP
 * SDK's `parseErrorResponse` (client/auth.js) builds
 * `Invalid OAuth error response: … Raw body: ${body}` for ANY non-OAuth-shaped
 * error body from the token or registration endpoint — and the request that
 * provoked it carried the authorization `code` and the PKCE `code_verifier`,
 * so a provider that echoes the request would put both into libi's log file.
 * pino's key-based `redact` cannot help there: the secret is inside a string,
 * not under a key. Dropping the message is what does.
 */
export function errShape(err: unknown): { errName: string; code?: string; oauthCode?: string } {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  // The SDK's `OAuthError` carries its RFC 6749 code on `errorCode`
  // ("invalid_grant", "invalid_client", …) rather than on `code`. It is a
  // fixed enum, never free text, and it is the one thing that tells a reader
  // WHICH failure this was once the message is gone.
  const oauthCode = (err as { errorCode?: unknown } | undefined)?.errorCode;
  return {
    errName: err instanceof Error ? err.name : typeof err,
    ...(typeof code === "string" && code ? { code } : {}),
    ...(typeof oauthCode === "string" && oauthCode ? { oauthCode } : {}),
  };
}
