import { SENTRY_DSN, SENTRY_ENABLED } from "@/lib/sentry/config";

// Single source of truth for libi's Content-Security-Policy (RC-C part 2 / RC-G).
//
// The load-bearing directive is `connect-src 'self'`: even if a renderer-side
// denylist bypass (RC-C) compiles and runs attacker-controlled JS, the CSP
// prevents it from opening a network connection to any host other than the
// app's own origin — so it cannot exfiltrate data off-machine, MODULO the
// three narrow, deliberate allowlist relaxations below (GA4, the marketing
// site, Sentry), each scoped to one specific host we operate rather than an
// arbitrary attacker target. Read those trade-off blocks before assuming
// `'self'` is the whole story.
//
// Several relaxations are REQUIRED for the app to function and must not be
// removed:
//   - `script-src 'unsafe-eval'` — the client renderer compiles draw/overlay
//     (canvas / code / three) function bodies via `new Function`; without it
//     every canvas scene and code overlay throws.
//   - `worker-src blob:` — MediaBunny spawns its WebCodecs decode workers from
//     blob URLs (timeline preview + canvas-source export).
//   - `img-src`/`media-src data: blob:` — preview video frames and thumbnails
//     are served as blob:/data: URLs.
//   - `style-src 'unsafe-inline'` — Next.js + Tailwind inject inline styles.
//   - `object-src 'self'` — the PDF asset preview uses a same-origin
//     `<embed type="application/pdf">` (asset-media-view.tsx); `'none'` blocks
//     it. `'self'` still forbids cross-origin plugins.
//
// DELIBERATE TRADE-OFF (product decision): the GA4 analytics hosts below are
// allowlisted in script-src / connect-src / img-src so client-side gtag.js
// (`lib/analytics/client.ts`) works in packaged/npx builds. This narrowly
// weakens the anti-exfil guarantee — a denylist-bypassing renderer script could
// beacon data to Google's collect endpoints — but ONLY to those two Google
// origins, not to an arbitrary attacker host. Analytics is opt-out (Settings →
// Privacy). If the anti-exfil guarantee is later prioritised over client
// analytics, drop these and rely on the server-side Measurement Protocol.
//
// SECOND DELIBERATE TRADE-OFF: the marketing site's origin is allowlisted in
// connect-src so the libi Pro waitlist card (`lib/waitlist-api.ts`) can POST an
// address the user typed to `/api/waitlist`. Same shape of weakening as the GA
// entry — one known origin we operate, not an arbitrary host — and the endpoint
// it reaches is write-only by construction (its service account holds
// `datastore.entities.create` and nothing else), so it is not a read-back
// channel. Without this the POST is blocked by the browser and the card can
// only ever report "couldn't reach the server".
//
// It tracks NEXT_PUBLIC_LIBI_SITE_URL rather than being hardcoded, so pointing
// the app at a staging site does not require editing the CSP — the two would
// drift, and the failure mode is silent in dev and invisible until someone
// tries to sign up.
const SITE_CONNECT = (
  process.env.NEXT_PUBLIC_LIBI_SITE_URL ?? "https://libi.nagellabs.com"
).replace(/\/+$/, "");

// THIRD DELIBERATE TRADE-OFF: the Sentry ingest host is allowlisted in
// connect-src so client-side crash reports can leave the renderer at all.
// Verified, not assumed: booting with Sentry forced on
// (`scripts/dev-sentry-live.js --real-dsn`) and throwing a renderer error
// showed DevTools reporting `Refused to connect ... violates ... Content
// Security Policy` for the ingest URL, and no envelope reached Sentry — this
// file's OWN `connect-src 'self'` was silently blocking the crash reporter
// `lib/sentry/config.ts` and the Settings "Send crash reports" toggle promise.
// After adding the host below, the same probe reached Sentry.
//
// Same shape of weakening as the two entries above — one host we operate (our
// Sentry org), not an arbitrary attacker target — but the cost is real and
// worth stating plainly: Sentry's ingest endpoint is designed to accept
// arbitrary JSON envelopes from any client holding the (non-secret, publicly
// shipped) DSN, so a renderer-side denylist bypass (RC-C) that compiles and
// runs attacker JS could beacon exfiltrated data to this host too, disguised
// as telemetry, and it would not stand out in Sentry's own dashboards. This is
// a narrower channel than an arbitrary host, but it is not a theoretical one.
//
// Derived from SENTRY_DSN rather than hardcoded, for the same reason
// SITE_CONNECT tracks an env var above: a self-hoster or staging deploy that
// overrides NEXT_PUBLIC_SENTRY_DSN (see `lib/sentry/config.ts`) would otherwise
// have crash reporting silently CSP-blocked again, with no signal beyond a
// console line nobody is watching.
//
// Gated on SENTRY_ENABLED, not merely on DSN parseability. SENTRY_DSN has a
// committed default (see `lib/sentry/config.ts`), so it always parses to a
// real origin — but reporting only actually fires when SENTRY_ENABLED is also
// true (NEXT_PUBLIC_LIBI_SENTRY=1, set by the launchers for genuine end-user
// installs, and not kill-switched). Without this gate, a dev clone, a
// kill-switched install, or an opt-out user would carry an exfil-capable
// external origin in their CSP for a reporter that will never send anything —
// pure downside, no corresponding functionality.
const SENTRY_CONNECT = (() => {
  if (!SENTRY_ENABLED) return "";
  try {
    return new URL(SENTRY_DSN).origin;
  } catch {
    return "";
  }
})();

// The directives are emitted verbatim by `proxy.ts` on every app/page response.
const GA_SCRIPT = "https://www.googletagmanager.com";
const GA_CONNECT = "https://www.google-analytics.com https://*.google-analytics.com https://www.googletagmanager.com";
const GA_IMG = "https://www.google-analytics.com https://*.google-analytics.com";

// Terminal-surface WebSocket (lib/terminal/ws-server.ts): PTY I/O rides a
// dedicated `ws` server on a SEPARATE loopback port (App Router can't upgrade
// WebSockets), so it is cross-origin to the page and `'self'` does not cover
// it. The port is dynamic by design — worktree-derived in the dev range,
// `LIBI_TERMINAL_WS_PORT` override, ephemeral fallback on collision, and
// always-ephemeral in packaged production — and the server binds lazily AFTER
// the page's CSP has been emitted, so an exact-port source is impossible; the
// wildcard port is required. Loopback-only (`ws:` to 127.0.0.1 stays
// on-machine), so the anti-exfiltration guarantee above is preserved; the ws
// server additionally enforces its own loopback Origin gate on upgrade.
const TERMINAL_WS = "ws://127.0.0.1:*";

// SENTRY_CONNECT is "" when Sentry is disabled (see above) — filter it out
// rather than interpolate directly, or the directive would carry a stray
// trailing space.
const CONNECT_SRC = ["'self'", TERMINAL_WS, GA_CONNECT, SITE_CONNECT, SENTRY_CONNECT]
  .filter(Boolean)
  .join(" ");

const CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  `connect-src ${CONNECT_SRC}`,
  `img-src 'self' data: blob: ${GA_IMG}`,
  "media-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-eval' 'unsafe-inline' ${GA_SCRIPT}`,
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "object-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
];

/**
 * Build the strict Content-Security-Policy header value. Single source of
 * truth — do not inline the directive string anywhere else.
 */
export function buildCsp(): string {
  return CSP_DIRECTIVES.join("; ");
}
