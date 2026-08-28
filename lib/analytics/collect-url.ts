// lib/analytics/collect-url.ts
// The GA4 wire format for a WEB data stream — `/g/collect`, the endpoint gtag.js
// itself posts to.
//
// Why not the Measurement Protocol (`/mp/collect`)? Because it requires an
// api_secret, and libi has nowhere to keep one. libi has no backend: the "server"
// is a second process on the user's own machine, so anything it holds is as public
// as anything the browser holds. Shipping the secret would publish it; not shipping
// it is what we did, and it left every server-side event silently disabled in every
// install (`DEFAULT_API_SECRET = ""`, and an early return when it is empty).
//
// A web stream accepts events with no secret at all — that is how every public
// gtag site on the internet works, and the measurement ID is already committed and
// already public. So this transport needs no credential, nothing injected at
// release time, and works identically from the browser and the local server.
//
// The trade, stated plainly: `/g/collect` is not a documented API. Google can
// change it. That is why `lib/analytics/queue.ts` logs any non-2xx response — if
// this stops working we find out from our own logs instead of from an empty
// dashboard six weeks later.
import type { AnalyticsParams } from "./events";

export const COLLECT_ENDPOINT = "https://www.google-analytics.com/g/collect";

export interface CollectEvent {
  /** GA4 event name; must be one of `EVENT_NAMES`. */
  name: string;
  params: AnalyticsParams;
  /** Stable per install. GA4's `cid`. */
  clientId: string;
  /** Same value as `clientId` for libi — one install is one user. GA4's `uid`. */
  userId: string;
  /** Unix seconds at session start, as a string. GA4's `sid`. */
  sessionId: string;
  /** 1-based hit counter within the session. GA4's `_s`. */
  hitNumber: number;
  /** First hit of a new session. */
  sessionStart: boolean;
  /** First hit this install has ever sent. */
  firstVisit: boolean;
  /** Route the hit to GA4 DebugView. */
  debug: boolean;
  /** Engagement time in ms. GA4 drops a session whose hits report none. */
  engagementMs: number;
}

export function buildCollectUrl(ev: CollectEvent, measurementId: string): string {
  const q = new URLSearchParams();
  q.set("v", "2");
  q.set("tid", measurementId);
  q.set("cid", ev.clientId);
  q.set("sid", ev.sessionId);
  q.set("_s", String(ev.hitNumber));
  q.set("en", ev.name);
  // GA4 treats a hit with no engagement time as non-engaged and can drop the
  // session entirely, so this is never omitted — 1ms is the floor.
  q.set("_et", String(Math.max(1, Math.round(ev.engagementMs))));
  if (ev.userId) q.set("uid", ev.userId);
  if (ev.sessionStart) q.set("_ss", "1");
  if (ev.firstVisit) q.set("_fv", "1");
  if (ev.debug) q.set("_dbg", "1");

  // Numbers go under `epn.`, everything else under `ep.`. Sending a number as a
  // string makes GA4 register it as a text dimension, which cannot be summed.
  for (const [k, v] of Object.entries(ev.params)) {
    if (typeof v === "number") q.set(`epn.${k}`, String(v));
    else q.set(`ep.${k}`, String(v));
  }
  return `${COLLECT_ENDPOINT}?${q.toString()}`;
}
