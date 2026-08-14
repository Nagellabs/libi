// lib/analytics/client.ts
// Browser GA4 transport via gtag.js (no firebase dependency). Loaded once by the
// AnalyticsProvider with client_id + user_id pinned to the install UUID.
"use client";

import { ANALYTICS_DEBUG, MEASUREMENT_ID } from "./config";
import { sanitizeParams } from "./events";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

let initialized = false;
let trackingEnabled = true;

/** Inject gtag.js and configure GA4 with the install UUID. Idempotent. */
export function initAnalytics(userId: string): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag(...args: unknown[]) {
    window.dataLayer!.push(args);
  };
  window.gtag("js", new Date());
  window.gtag("config", MEASUREMENT_ID, {
    client_id: userId,
    user_id: userId,
    ...(ANALYTICS_DEBUG ? { debug_mode: true } : {}),
    send_page_view: false, // we emit page_view explicitly with a normalized path
  });

  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.appendChild(s);
}

/** Log a GA4 event from the browser. No-ops until initAnalytics has run, or
 *  once the user has opted out via setClientAnalyticsEnabled(false). */
export function trackEvent(name: string, params?: Record<string, unknown>): void {
  if (!trackingEnabled || !initialized || typeof window === "undefined" || !window.gtag) return;
  window.gtag("event", name, sanitizeParams(params));
}

/** Live opt-out/opt-in teardown for the client transport — stops gtag emitting
 *  WITHOUT a page reload. Flips our own guard AND GA4's documented
 *  `ga-disable-<MEASUREMENT_ID>` global (which gtag.js itself honors), so no
 *  further events leave the browser after opt-out. The authoritative gate is
 *  still server-side; this closes the client half. */
export function setClientAnalyticsEnabled(on: boolean): void {
  trackingEnabled = on;
  if (typeof window !== "undefined") {
    (window as unknown as Record<string, boolean>)[`ga-disable-${MEASUREMENT_ID}`] = !on;
  }
}
