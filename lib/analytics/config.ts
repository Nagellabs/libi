// lib/analytics/config.ts
// GA4 analytics config — committed constants + enablement, mirroring
// lib/sentry/config.ts. The packaged Electron build and `npx libi` CLI have no
// .env at runtime, so the measurement ID is HARDCODED here.
//
// SECURITY: a hardcoded measurement ID is fine to commit — GA4 web streams
// (`/g/collect`, see lib/analytics/collect-url.ts) accept events with NO
// secret at all, the same way every public gtag site on the internet works.
// Both transports (browser and server) send through that one web-stream path
// now, so there is no server/client asymmetry left to guard and no secret to
// lose. This file used to also hold a Measurement Protocol api_secret, whose
// absence silently disabled every server-side event in every install; it is
// gone along with the path that needed it.

/** GA4 web data stream measurement ID (public). Env override for staging/self-host. */
export const MEASUREMENT_ID =
  process.env.NEXT_PUBLIC_LIBI_GA4_MEASUREMENT_ID || "G-7XJTYHWMFN";

/** Loose env shape — accepts process.env and plain object literals (for tests). */
type EnvLike = Record<string, string | undefined>;

/** Pure enablement resolver (testable). Default OFF; opt-in flag set by launchers
 *  for real installs; hard kill-switch wins. */
export function resolveAnalyticsEnabled(env: EnvLike): boolean {
  return env.LIBI_ANALYTICS_DISABLED !== "1" && env.NEXT_PUBLIC_LIBI_ANALYTICS === "1";
}

/** debug_mode → GA4 DebugView.
 *
 * On by default outside production, so a dev clone's events land in DebugView
 * instead of the real reports. `LIBI_ANALYTICS_DEBUG=1` turns it on explicitly,
 * and that opt-in is the ONLY way to inspect a RELEASED build: every artifact we
 * publish is built with NODE_ENV=production, so without it a shipped install can
 * never appear in DebugView — which is where a hit's full parameter payload is
 * visible, and therefore the only place "the funnel sends the right enums" can
 * actually be checked. Realtime shows that events arrived; it does not show what
 * they carried. Release-day QA sets this on the QA instance and nowhere else.
 *
 * The cost of leaving it on is real, which is why it stays opt-in: GA4 excludes
 * debug_mode hits from standard reports, so a user who set it would go
 * uncounted. */
export function resolveAnalyticsDebug(env: EnvLike): boolean {
  return env.LIBI_ANALYTICS_DEBUG === "1" || env.NODE_ENV !== "production";
}

/** Process-resolved values for runtime use. */
export const ANALYTICS_ENABLED = resolveAnalyticsEnabled(process.env);
export const ANALYTICS_DEBUG = resolveAnalyticsDebug(process.env);

/** The user's hard kill-switch. Deliberately separate from ANALYTICS_ENABLED,
 *  which also folds in the build-time opt-in: the build flag decides whether
 *  we SEND, this decides whether we may RECORD ANYTHING AT ALL. */
export const ANALYTICS_KILL_SWITCH = process.env.LIBI_ANALYTICS_DISABLED === "1";
