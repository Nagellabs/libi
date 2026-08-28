// lib/analytics/server.ts
// Server-side analytics entry point. Every server, route, job and MCP event
// lands here, and here just means "onto the durable queue" — the queue owns
// identity, sessionisation, sending and retry.
import { enqueueAnalyticsEvent } from "@/lib/analytics/queue";

/** Record one analytics event. Synchronous, total, and fire-and-forget: it
 *  cannot throw, cannot block, and cannot fail the flow that called it.
 *
 *  The signature is deliberately `void` and not `Promise<void>`. The old one
 *  returned a promise that every caller discarded with `void`, which made it
 *  look awaitable when awaiting it meant "wait for Google" on a user's
 *  critical path. There is nothing to await now.
 *
 *  enqueueAnalyticsEvent is itself total (it has its own internal catch),
 *  but this wrapper does not lean on that alone — "cannot throw" is a
 *  promise this function makes on its own behalf, so it holds even if the
 *  queue's contract ever changes underneath it. */
export function trackServerEvent(
  name: string,
  params?: Record<string, unknown>,
): void {
  try {
    enqueueAnalyticsEvent(name, params);
  } catch {
    // Total: analytics must never be the reason a caller's own flow breaks.
  }
}
