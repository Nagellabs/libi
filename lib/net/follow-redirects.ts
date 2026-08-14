import type { Agent } from "undici";

/**
 * Node 24's global `fetch` (backed by undici under the hood) accepts a
 * `dispatcher` option so a request can be pinned to a specific undici
 * `Agent` — but the DOM `RequestInit` type `fetch` is typed against doesn't
 * know that option exists. Runtime behavior is correct either way; this
 * just gives call sites a real type instead of an `as` cast or a silent
 * `tsc` error.
 */
export type RequestInitWithDispatcher = RequestInit & { dispatcher?: Agent };

/** What a URL guard hands back for ONE hop: the parsed URL, plus — when the
 * guard resolved DNS itself — a dispatcher pinned to the vetted address(es)
 * so the connection that's actually opened can't rebind to a different
 * address than the one just checked. Loopback-shaped hops (see
 * `assertLoopbackOrPublicHttpUrl`) skip DNS entirely and omit it. */
export interface VettedRedirectTarget {
  url: URL;
  dispatcher?: Agent;
}

/** Vets exactly ONE url (one hop of a possible redirect chain) and either
 * returns the parsed url (+ dispatcher) or throws to reject the hop. */
export type UrlGuard = (raw: string) => Promise<VettedRedirectTarget>;

/** Bound on the manual redirect chain — mirrors `lib/security/download-verify.ts`. */
const MAX_REDIRECTS = 10;

/**
 * Fetch `rawUrl`, following redirects MANUALLY and re-running `guard` on
 * EVERY hop before it is dereferenced — not just the start of the chain. A
 * permitted host can 302 (or chain through several hops) to a
 * private/loopback/metadata address; checking only the initial URL (and
 * letting `fetch`'s default `redirect: "follow"` walk the rest) lets that
 * internal request actually be issued before any check ever sees it. Each
 * hop also rides `guard`'s pinned `dispatcher` when it returns one, so the
 * socket that's actually opened can't rebind to a different address than
 * the one DNS just vetted for THAT hop.
 *
 * Shared by `lib/jobs/runners/remote-fetch.ts` (guard: `assertPublicHttpUrl`)
 * and `lib/jobs/runners/tracking.ts` (guard: `assertLoopbackOrPublicHttpUrl`
 * bound to the app's own port) — one implementation, two callers, so the two
 * can't drift out of sync the way they did before (tracking.ts fetched the
 * vetted url with the default follow-redirect behavior and no per-hop
 * re-vetting at all).
 */
export async function fetchFollowingVettedRedirects(
  rawUrl: string,
  guard: UrlGuard,
  init?: RequestInit,
): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { url, dispatcher } = await guard(current);
    const fetchInit: RequestInitWithDispatcher = { ...init, redirect: "manual" };
    if (dispatcher) fetchInit.dispatcher = dispatcher;

    let res: Response;
    try {
      res = await fetch(url.href, fetchInit);
    } catch (err) {
      // Never dispatched (or failed before headers) — nothing to drain.
      if (dispatcher) void dispatcher.close().catch(() => {});
      throw err;
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location) {
        // This hop's body is a redirect page nobody will ever read. Cancel
        // it before closing the dispatcher — `Agent#close()` waits for the
        // in-flight request to fully drain, and an unread body of any real
        // size (verified empirically: a single small chunk resolves
        // instantly, but a larger unread body hangs `close()` indefinitely)
        // would otherwise hang this closer forever.
        if (res.body) void res.body.cancel().catch(() => {});
        if (dispatcher) void dispatcher.close().catch(() => {});
        // Resolve relative to the hop we just vetted, then loop — the NEXT
        // iteration re-vets `next` before it is ever fetched.
        current = new URL(location, url).href;
        continue;
      }
    }

    // Final hop (or a 3xx with no Location — handed back as-is). The caller
    // still needs to read `res.body` through this dispatcher's connection,
    // so `close()` must NOT be awaited here: it resolves once the body is
    // fully drained/canceled downstream (verified empirically), so firing
    // it now — without blocking — frees the keep-alive pool the moment the
    // caller finishes reading instead of leaking it until idle-timeout (M1).
    if (dispatcher) void dispatcher.close().catch(() => {});
    return res;
  }
  throw new Error(`too many redirects (>${MAX_REDIRECTS}) while fetching ${rawUrl}`);
}
