import { NextResponse } from "next/server";
import { isStoryboardBusyError } from "./lock";

/** The one HTTP mapping for a storyboard lock timeout: 409 Conflict with the
 *  error's message. `retryable` is false when the operation may have partly
 *  landed (commit/discard draft) — the client should reload state first.
 *  Null for any other error, so callers keep their own mapping. */
export function storyboardBusyResponse(err: unknown): NextResponse | null {
  if (!isStoryboardBusyError(err)) return null;
  return NextResponse.json(
    { error: err.message, retryable: !err.partial, partial: err.partial },
    { status: 409 },
  );
}

/** Wrap a route handler so a StoryboardBusyError becomes a 409 instead of an
 *  unhandled 500. Every other error is rethrown untouched. */
export function withStoryboardBusy<A extends unknown[], R extends Response>(
  handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R | NextResponse> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (err) {
      const busy = storyboardBusyResponse(err);
      if (busy) return busy;
      throw err;
    }
  };
}
