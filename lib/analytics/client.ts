// lib/analytics/client.ts
// Browser analytics transport: POST to libi's own server, which owns the queue.
//
// This used to load gtag.js. It no longer does, for three reasons that all point
// the same way:
//
//   1. The browser is not always there. libi's most interesting events happen
//      around setup, and a window that is closed mid-setup takes its unsent
//      events with it. The server process outlives the window.
//   2. gtag no-op'd until it had loaded, so the earliest events in a new
//      install's first session — the ones the funnel is made of — were dropped.
//   3. One transport is testable. Two are a question about which of them was on.
//
// The server is not a "real" server in any sense that matters here: it runs on
// the user's own machine, so it is a client, and it reports as one — with the
// public measurement ID and no secret. See lib/analytics/collect-url.ts.
"use client";

import { sanitizeParams } from "./events";

let trackingEnabled = true;

/** Kept for API compatibility with `AnalyticsProvider`. Identity is minted
 *  server-side now, so there is nothing to configure in the browser. */
export function initAnalytics(_userId: string): void {
  trackingEnabled = true;
}

/** Log an event. Fire-and-forget, and safe to call before anything has
 *  initialised — the server holds the queue, so there is no window in which
 *  events are silently discarded. */
export function trackEvent(name: string, params?: Record<string, unknown>): void {
  if (!trackingEnabled || typeof window === "undefined") return;
  void fetch("/api/analytics/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, params: sanitizeParams(params) }),
    keepalive: true,
    signal: AbortSignal.timeout(3000),
  }).catch(() => {
    // Best-effort by contract. A failed analytics call must never reach a user.
  });
}

/** Live opt-out/opt-in without a reload. The authoritative gate is still
 *  server-side (the drain refuses, and clears the queue); this closes the
 *  browser half immediately so nothing further even leaves the window. */
export function setClientAnalyticsEnabled(on: boolean): void {
  trackingEnabled = on;
}
