// lib/analytics/config.ts
// GA4 analytics config — committed constants + enablement, mirroring
// lib/sentry/config.ts. The packaged Electron build and `npx libi` CLI have no
// .env at runtime, so the measurement ID is HARDCODED here; the MP api_secret
// is deliberately NOT (see SECURITY note below) and must come from the
// environment, which means server-side event injection is off by default in
// every install unless LIBI_GA4_API_SECRET is set.
//
// SECURITY: a hardcoded measurement ID is fine — GA4 web streams accept
// events with NO secret at all (every public gtag site does this), so on the
// CLIENT gtag path a committed value guards nothing already-open, same
// posture as the committed Sentry DSN. The MEASUREMENT PROTOCOL (server-side)
// path is different: the api_secret is the only gate on someone posting
// fabricated events to `mp/collect` under this measurement ID. A hardcoded
// default here would hand that gate to anyone who reads this file, so unlike
// the measurement ID it is NOT committed.

/** GA4 web data stream measurement ID (public). Env override for staging/self-host. */
export const MEASUREMENT_ID =
  process.env.NEXT_PUBLIC_LIBI_GA4_MEASUREMENT_ID || "G-7XJTYHWMFN";

// Measurement Protocol api_secret — NOT committed, see security note above.
// Created in GA4 Admin → Data Streams → web stream → "Measurement Protocol API secrets".
// Empty = server/MCP events gracefully no-op (client gtag still works).
const DEFAULT_API_SECRET = "";

/** Resolved api_secret (env override wins). Empty string ⇒ server transport disabled. */
export const GA4_API_SECRET = process.env.LIBI_GA4_API_SECRET || DEFAULT_API_SECRET;

/** Loose env shape — accepts process.env and plain object literals (for tests). */
type EnvLike = Record<string, string | undefined>;

/** Pure enablement resolver (testable). Default OFF; opt-in flag set by launchers
 *  for real installs; hard kill-switch wins. */
export function resolveAnalyticsEnabled(env: EnvLike): boolean {
  return env.LIBI_ANALYTICS_DISABLED !== "1" && env.NEXT_PUBLIC_LIBI_ANALYTICS === "1";
}

/** debug_mode → GA4 DebugView; true only in `next dev` (sandbox), never packaged. */
export function resolveAnalyticsDebug(env: EnvLike): boolean {
  return env.NODE_ENV !== "production";
}

/** Process-resolved values for runtime use. */
export const ANALYTICS_ENABLED = resolveAnalyticsEnabled(process.env);
export const ANALYTICS_DEBUG = resolveAnalyticsDebug(process.env);
