import { CATALOG_BUCKET_BASES } from "@/lib/templates/cloud/constants";
import { SENTRY_DSN, SENTRY_ENABLED } from "@/lib/sentry/config";
import { socialMediaOrigins } from "@/lib/social/catalog";
import { isTestMode } from "@/lib/test-mode";
import { OVERLAY_RUNTIME_BUNDLE_PATH, OVERLAY_RUNTIME_PATH } from "@/lib/sandbox/paths";

// Single source of truth for libi's Content-Security-Policy (RC-C part 2 / RC-G).
//
// The load-bearing directive is `connect-src 'self'`: even if a renderer-side
// denylist bypass (RC-C) compiles and runs attacker-controlled JS, the CSP
// prevents it from opening a network connection to any host other than the
// app's own origin — so it cannot exfiltrate data off-machine, MODULO the
// two narrow, deliberate `connect-src` relaxations below (the marketing site,
// Sentry), each scoped to one specific host we operate rather than an
// arbitrary attacker target. Read those trade-off blocks before assuming
// `'self'` is the whole story. A third and a fourth relaxation (a social
// provider's media origin, the public templates catalog's two bucket paths)
// touch only `media-src`/`img-src` — display sinks, not connections — and are
// documented with the others.
//
// GA4 analytics used to be a third relaxation here — script-src/connect-src/
// img-src allowlisted the two GA4 web-stream hosts so client-side gtag.js
// could run in the renderer. That transport is gone (see
// lib/analytics/client.ts): the browser now POSTs same-origin to
// `/api/analytics/event`, and only the Next server process — not the
// renderer, so not subject to this CSP at all — talks to the analytics
// endpoint, via lib/analytics/collect-url.ts. So this file no longer grants
// a renderer-side denylist bypass any exfil path off-machine through
// analytics; removing the allowlist was pure upside, not a trade-off.
//
// Several relaxations are REQUIRED for the app to function and must not be
// removed:
//   - `script-src 'unsafe-eval'` — Next dev needs it (React uses `eval` in
//     development for its debugging information; see Next's CSP guide in
//     node_modules/next/dist/docs), and so does the one in-page
//     `new Function` user left: the dev-only `LIBI_OVERLAY_SANDBOX=0` in-origin
//     transport (lib/sandbox/in-origin-transport.ts), whose same-origin blob
//     worker inherits this policy and compiles bodies in
//     lib/sandbox/runtime/compile.ts. Overlay, three and effect bodies no
//     longer compile in the page in any shipped mode — they run in the
//     overlay sandbox under its own policy (buildOverlayRuntimeCsp below).
//     `lib/ai/scene-validator.ts`'s `new Function` calls run server-side
//     (the overlay watcher, template install, the Node storyboard worker's
//     `createDrawFunction`) or inside the sandbox runtime
//     (lib/sandbox/runtime/compile.ts and effect-curve.ts use its
//     `createDrawFunction` / `createAnimateFunction` — which is how the
//     in-origin transport reaches them), and `lib/engine/three-overlay.ts`
//     only mentions it in a comment. Re-check with `grep -rn "new Function" lib components
//     hooks` before tightening this. The directive is also sent in
//     production, where neither of those applies — this list is one policy
//     for both — so dropping it there is a separate change to verify on a
//     packaged build, not something this comment establishes.
//   - `worker-src blob:` — MediaBunny spawns its WebCodecs decode workers from
//     blob URLs (timeline preview + canvas-source export).
//   - `img-src`/`media-src data: blob:` — preview video frames and thumbnails
//     are served as blob:/data: URLs.
//   - `style-src 'unsafe-inline'` — Next.js + Tailwind inject inline styles.
//   - `object-src 'self'` — the PDF asset preview uses a same-origin
//     `<embed type="application/pdf">` (asset-media-view.tsx); `'none'` blocks
//     it. `'self'` still forbids cross-origin plugins.
//
// FIRST DELIBERATE TRADE-OFF: the marketing site's origin is allowlisted in
// connect-src so the libi Pro waitlist card (`lib/waitlist-api.ts`) can POST an
// address the user typed to `/api/waitlist`. One known origin we operate, not
// an arbitrary host — and the endpoint it reaches is write-only by
// construction (its service account holds `datastore.entities.create` and
// nothing else), so it is not a read-back channel. Without this the POST is
// blocked by the browser and the card can only ever report "couldn't reach
// the server".
//
// It tracks NEXT_PUBLIC_LIBI_SITE_URL rather than being hardcoded, so pointing
// the app at a staging site does not require editing the CSP — the two would
// drift, and the failure mode is silent in dev and invisible until someone
// tries to sign up.
const SITE_CONNECT = (
  process.env.NEXT_PUBLIC_LIBI_SITE_URL ?? "https://libi.nagellabs.com"
).replace(/\/+$/, "");

// SECOND DELIBERATE TRADE-OFF: the Sentry ingest host is allowlisted in
// connect-src so client-side crash reports can leave the renderer at all.
// Verified, not assumed: booting with Sentry forced on
// (`scripts/dev-sentry-live.js --real-dsn`) and throwing a renderer error
// showed DevTools reporting `Refused to connect ... violates ... Content
// Security Policy` for the ingest URL, and no envelope reached Sentry — this
// file's OWN `connect-src 'self'` was silently blocking the crash reporter
// `lib/sentry/config.ts` and the Settings "Send crash reports" toggle promise.
// After adding the host below, the same probe reached Sentry.
//
// Same shape of weakening as the entry above — one host we operate (our
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
const CONNECT_SRC = ["'self'", TERMINAL_WS, SITE_CONNECT, SENTRY_CONNECT]
  .filter(Boolean)
  .join(" ");

// THIRD DELIBERATE TRADE-OFF: a social provider's media origin is allowlisted
// in `media-src` and `img-src` so a post's own video/image preview renders at
// all. `media-src 'self' blob: data:` blocked every preview in the Posting
// tab's detail sheet and every post-row thumbnail — an empty black player with
// one console line and nothing in the UI, on the one screen whose job is to
// show the user what is about to go out (QA 2026-09-21, finding 2).
//
// The origins come from `SOCIAL_PROVIDER_CATALOG` (`socialMediaOrigins()`),
// never hardcoded here: a second provider is then a catalog entry rather than
// an edit to this file, and the list is exactly the providers libi ships.
//
// Narrow by construction, and this is the whole of the widening: `connect-src`
// is UNTOUCHED, so the anti-exfiltration guarantee above is intact — a
// renderer-side bypass still cannot `fetch()` these hosts, only display a
// resource from one. `media-src`/`img-src` are display sinks, not read-back
// channels: a `<video>`/`<img>` gives the page no access to the bytes (canvas
// tainting still applies, and there is no credential to carry — the URLs are
// unauthenticated presigned objects). What an attacker gains is the ability to
// make libi SHOW a media file from one named host, not to send anything to it.
const SOCIAL_MEDIA_SRC = socialMediaOrigins().join(" ");

// FOURTH DELIBERATE TRADE-OFF: the public templates catalog's two buckets are
// allowlisted in `img-src` and `media-src` so a public template's poster and
// hover-play example render on the Templates page. Same shape as the social
// media origins above — a display sink, not a connection: `connect-src` is
// untouched, so a renderer-side bypass still cannot `fetch()` the bucket, only
// show an image or video from it.
//
// Scoped by PATH, never by origin. Every Google Cloud Storage bucket is served
// from the one origin https://storage.googleapis.com — an attacker's bucket as
// much as ours — so the bare origin would let any bucket's media render in
// libi. CSP source expressions carry a path, and a path ending in `/` matches
// everything under that directory and nothing else, so each source below is
// exactly one bucket. Both are always listed (prod and dev), read from the
// constants the cloud client itself uses
// (lib/templates/cloud/constants.ts#CATALOG_BUCKET_BASES) rather than retyped.
//
// One caveat the path scope depends on: after a redirect, CSP matches the
// origin alone and skips the path (CSP3, "Does url match expression in origin
// with redirect count?" compares paths only at redirect count 0). So a
// redirect from ANY source these directives admit into storage.googleapis.com
// would reach every bucket. Checked 2026-09-23: GCS answers a public object
// URL directly (200, or 404 — no redirect), and no libi route redirects to a
// caller-chosen URL. A new route that did would re-open every bucket.
//
// A dev build's catalog switch (Production ⇄ a development site, even a
// Vercel preview; lib/templates/cloud/catalog-setting.ts) needs NOTHING more
// here: the renderer never talks to a catalog site (the Node server does,
// through lib/templates/cloud/client.ts), and a development catalog's media is
// in the dev bucket, already listed. Don't add `*.vercel.app` to any directive.
const CATALOG_MEDIA_SRC = Object.values(CATALOG_BUCKET_BASES).join(" ");

// FIFTH DELIBERATE TRADE-OFF, TEST MODE ONLY: the fake Zernio's own origin is
// allowlisted in `img-src`/`media-src`, exactly like a real provider's above,
// so a test-mode post's placeholder thumbnail/video actually renders instead
// of failing the same silent-black-player way the third trade-off fixed for
// production (full-verification F9). It is computed at CALL time, never
// folded into the static `CSP_DIRECTIVES` below: the fake listens on an
// OS-assigned loopback port chosen when test mode starts it
// (`mcp/dev/fake-zernio/http.ts`), which is after this module is first
// imported, so a value baked in at import time would always be empty.
//
// Reads `LIBI_SOCIAL_MCP_URL` directly, NEVER by importing `lib/social/test-fake`
// (I3, 2026-10-02 review). `csp.ts` is loaded by `proxy.ts` on EVERY request of
// EVERY build, and `test-fake.ts` statically imports `fs`, the pino logger,
// `lib/libi-home` and `SocialTokenStore` — and dynamically pulls in the fake HTTP
// server's own module graph — purely to hand one env var back out. None of that
// belongs in the per-request security chokepoint's own import graph: a failure to
// resolve or evaluate any module in that chain would take down every page and API
// response, in every build, for a test-mode-only convenience. A leaf env read has
// nothing to fail to import. `LIBI_SOCIAL_MCP_URL` is also exactly what
// `test-fake.ts` itself ultimately reads (`fakeZernioUrl()`'s own fallback) once
// the module-instance-local `started` cache it prefers is empty — which it always
// is from the PROXY's separate module instance anyway, so reading the env var
// directly is not a behavior change, only a dependency-free one.
//
// Loopback-only (M4): this env var is inherited PROCESS env, and a packaged app's
// env is whatever launched it. Restricting the host to 127.0.0.1/localhost/[::1]
// means even a `LIBI_TEST_MODE=1` launch with a tampered URL can never widen the
// CSP to name a non-local origin — the widening stays exactly what it claims to
// be, a loopback test fixture, never a vector for naming an arbitrary host.
//
// Outside test mode `isTestMode()` is false and this returns `""`, so
// production's `img-src`/`media-src` are byte-identical to before — this
// trade-off does not exist for a real install. The fake's `/mcp` endpoint and its
// `/media/<key>` uploads share one origin (`FakeZernioHttp.baseUrl` — same
// listener, see http.ts), so deriving one from the other never drifts.
// `connect-src` is untouched, same as the real-provider trade-off: a
// compromised renderer still cannot `fetch()` the fake, only display a
// resource from it.
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

function testModeSocialMediaOrigin(): string {
  if (!isTestMode()) return "";
  const raw = process.env.LIBI_SOCIAL_MCP_URL;
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return "";
    return url.origin;
  } catch {
    return "";
  }
}

const CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  `connect-src ${CONNECT_SRC}`,
  `img-src 'self' data: blob: ${SOCIAL_MEDIA_SRC} ${CATALOG_MEDIA_SRC}`,
  `media-src 'self' blob: data: ${SOCIAL_MEDIA_SRC} ${CATALOG_MEDIA_SRC}`,
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  // The overlay-sandbox iframe (lib/sandbox/iframe-transport.ts) is same-URL
  // under an opaque origin; `frame-src 'self'` admits it and `child-src`
  // mirrors that for UAs that consult the older directive.
  "child-src 'self'",
  // Nothing off-origin may frame the app (anti-clickjacking). `'self'`, not
  // `'none'` (spec §4.10 said `'none'`; deliberately deviated): Chromium
  // enforces frame-ancestors on `<embed>`, and this policy is stamped on every
  // proxied response — so `'none'` on `/api/files/by-id/<id>/content` blanked
  // the editor's same-origin PDF `<embed>` (asset-media-view.tsx; reproduced
  // in Playwright Chromium). `'self'` still refuses every cross-origin framer,
  // and the one same-origin document that could frame an app page, the
  // opaque-origin overlay runtime, has `default-src 'none'` and no `frame-src`.
  // The runtime page carries its own `frame-ancestors <studio>`
  // (buildOverlayRuntimeCsp below; cspForPath picks one policy, never both).
  "frame-ancestors 'self'",
  "object-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
];

/**
 * Build the strict Content-Security-Policy header value. Single source of
 * truth — do not inline the directive string anywhere else.
 */
export function buildCsp(): string {
  const testOrigin = testModeSocialMediaOrigin();
  if (!testOrigin) return CSP_DIRECTIVES.join("; ");
  // Additive only, and only these two display-sink directives — see the
  // fifth trade-off above.
  return CSP_DIRECTIVES.map((d) =>
    d.startsWith("img-src ") || d.startsWith("media-src ") ? `${d} ${testOrigin}` : d,
  ).join("; ");
}

export { OVERLAY_RUNTIME_PATH, OVERLAY_RUNTIME_BUNDLE_PATH };

/**
 * The runtime page's own policy — stricter than the app's, and the reason the
 * sandbox holds even if a body bypasses every denylist: no network at all
 * (`connect-src 'none'`), no navigation targets, no forms, only the
 * content-hashed bundle plus `'unsafe-eval'` (which `new Function` needs).
 * A1: bodies run in a classic Web Worker spawned from a `blob:` URL, so
 * `worker-src blob:` admits the worker and `script-src` also carries `blob:`
 * (measured in the spike — round 2 "One finding that constrains the real
 * implementation"). `studioOrigin` is the embedding page's origin
 * (`http://127.0.0.1:<port>` or `http://localhost:<port>`), from the request's Host.
 *
 * `sandbox allow-scripts` makes the page opaque-origin however it is loaded
 * (final security review, M2): the iframe's own `sandbox` attribute does that
 * for the studio, but opened top-level — which `frame-ancestors` does not
 * prevent — the page would run at the studio's origin, and a regression that
 * dropped the attribute would go with it. The flags equal the attribute's, so
 * the two together are exactly what the frame always had.
 */
export function buildOverlayRuntimeCsp(studioOrigin: string): string {
  return [
    "default-src 'none'",
    `script-src ${studioOrigin}${OVERLAY_RUNTIME_BUNDLE_PATH} 'unsafe-eval' blob:`,
    "img-src blob: data:",
    "font-src data:",
    "connect-src 'none'",
    "worker-src blob:",
    `frame-ancestors ${studioOrigin}`,
    "base-uri 'none'",
    "form-action 'none'",
    "sandbox allow-scripts",
  ].join("; ");
}

/** What `proxy.ts` puts on a response for `pathname`: the runtime page gets its
 *  strict policy, everything else the app policy. Pure, so it is testable
 *  without a NextRequest. */
export function cspForPath(pathname: string, origin: string): string {
  return pathname === OVERLAY_RUNTIME_PATH ? buildOverlayRuntimeCsp(origin) : buildCsp();
}
