/**
 * Retry policy for every mediabunny `UrlSource` libi creates.
 *
 * Mediabunny's DEFAULT policy retries a failed byte-range fetch FOREVER —
 * `Math.min(2 ** (attempts - 2), 16)` seconds, capped at 16s, with no attempt
 * limit — unless it suspects a cross-origin CORS failure. Every libi media URL
 * is same-origin (the local server serves both the page and `/api/files/…`),
 * so that CORS escape hatch never fires and the default reduces to an infinite
 * loop.
 *
 * That cost a real debugging session on 2026-08-18. A dev Electron window was
 * left open after its Next server had exited, so every video source in the open
 * piece spun on an unreachable URL indefinitely. Two things made it hard to
 * read:
 *
 *   - `retriedFetch` logs `console.error('Retrying failed fetch. …')` on EVERY
 *     attempt, and Next's dev overlay renders a `console.error` as a first-class
 *     error — so the user saw "Console TypeError: Failed to fetch" over a stack
 *     naming nothing but mediabunny internals, forever, every ≤16s.
 *   - the read never rejected, so the catch blocks in `MediaBunnyFrameSource`'s
 *     decode pump and prime chain never ran. The preview just held its last-good
 *     frame with nothing anywhere explaining why.
 *
 * Bounding the retries turns both halves around: the console noise stops after a
 * handful of lines, and the read REJECTS, so the existing catches log a real
 * message naming the source.
 *
 * Giving up is safe precisely because it is not final. A failed read does not
 * dispose the `Input`, so the next seek, play, or source re-attach issues fresh
 * requests against a fresh worker — recovery becomes driven by what the user
 * does, instead of by a hidden loop they can neither see nor cancel.
 */

/** Retries allowed after the initial failure before a read is failed. */
export const MAX_FETCH_RETRIES = 4;

/**
 * Backoff for retries 1..MAX_FETCH_RETRIES, in seconds (~3.75s of waiting in
 * total). Deliberately short: preview decoding is interactive, so a source stuck
 * retrying is a frozen picture on screen, and the very next scrub or play
 * retries anyway. Long backoffs buy nothing a user action doesn't buy sooner.
 */
const RETRY_DELAYS_SEC = [0.25, 0.5, 1, 2];

/** Best-effort label for logs — `UrlSource` accepts a `Request` as well as a URL. */
function describeUrl(url: string | URL | Request): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.href;
  return url.url;
}

/**
 * Mediabunny `getRetryDelay`: seconds to wait before retry number
 * `previousAttempts`, or `null` to stop retrying and let the read reject.
 *
 * NOTE on the second caller: mediabunny also consults this policy when a
 * response stream dies MID-READ, and there it always passes
 * `previousAttempts === 1` (it is resuming one request, not counting failures).
 * So a mid-stream drop always earns one resume, which then re-enters the
 * request path above and is bounded there — a server that is simply gone still
 * terminates. A server that accepts connections but drops every stream can
 * still alternate resume/refetch; that is unchanged from mediabunny's default
 * and is not what this policy exists to fix.
 */
export function mediaFetchRetryDelay(
  previousAttempts: number,
  error: unknown,
  url: string | URL | Request,
): number | null {
  if (previousAttempts > MAX_FETCH_RETRIES) {
    console.warn(
      `[media] giving up on ${describeUrl(url)} after ${previousAttempts} failed fetches:`,
      (error as Error)?.message ?? error,
    );
    return null;
  }
  return RETRY_DELAYS_SEC[previousAttempts - 1] ?? RETRY_DELAYS_SEC.at(-1)!;
}
