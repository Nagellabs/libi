// Sentry — browser / client runtime.
// Next.js loads this automatically for the client bundle (no import needed).
//
// Privacy posture: identical "no identity, no keys" rules as the server.
// NOTE: Session Replay is deliberately NOT enabled — it screen-records the
// user's session, and this app handles user video/content. Reliability
// telemetry must stay pseudonymous.
import * as Sentry from "@sentry/nextjs";

import { SENTRY_DSN, SENTRY_ENABLED, SENTRY_ENVIRONMENT } from "./lib/sentry/config";
import {
  CRASH_REPORTS_STORAGE_KEY,
  readInjectedCrashReportConfig,
  readStoredCrashReportChoice,
  setCrashReportChoice,
  setServerKillSwitch,
} from "./lib/sentry/enabled";
import { gateTransport } from "./lib/sentry/gated-transport";
import { reconcileCrashReportChoiceFromServer } from "./lib/sentry/reconcile-client";
import { scrubEvent, scrubLog, scrubSpan, scrubTransaction } from "./lib/sentry/scrub";

// Seed the crash-report gate (lib/sentry/enabled.ts) from the localStorage
// mirror BEFORE Sentry.init, so the very first client-side event is already
// governed. On a first-ever run there is no mirror yet —
// readStoredCrashReportChoice() returns "unset", which shouldSendCrashReports()
// treats as enabled by design: failing closed here would silently drop the
// most valuable crash reports (the ones from a fresh install), so the first
// launch after install stays reportable. Disclosed in the privacy policy.
//
// The mirror is a CACHE, not the record — the DB is authoritative — so this
// seed is corrected against the server a moment later; see the reconcile call
// after Sentry.init below.
//
// PREFER THE SERVER-INJECTED SEED when the page carried one (the inline script
// the root layout writes; see lib/sentry/seed-script.ts). It is the persisted
// value, available at this same synchronous moment, and it is what makes an
// opt-out hold on the FIRST envelope rather than the first reconcile —
// `browserSessionIntegration` sends session-start inside `Sentry.init` below,
// and the packaged app's ephemeral port gives an opted-out user an empty
// localStorage mirror on essentially every launch (origin includes the port).
const injected = readInjectedCrashReportConfig();
setCrashReportChoice(injected ? injected.choice : readStoredCrashReportChoice());
if (injected) setServerKillSwitch(injected.killSwitched);

Sentry.init({
  // Committed public DSN (safe in the client bundle — send-only). Gated by
  // SENTRY_ENABLED so a dev clone never reports. See lib/sentry/config.ts.
  dsn: SENTRY_DSN,
  enabled: SENTRY_ENABLED,
  environment: SENTRY_ENVIRONMENT,

  sendDefaultPii: false,
  tracesSampleRate: 0.1,
  enableLogs: true,

  // No replayIntegration(), no feedbackIntegration() — keep telemetry
  // pseudonymous and free of recorded user content. (Both are opt-in; the
  // default integration set is otherwise left untouched.)

  // THE DROP MECHANISM for the opt-out. Wraps the SDK's own default fetch
  // transport so that, per envelope, nothing is sent while the user has opted
  // out. This deliberately replaced an earlier `integrations` filter that
  // removed `browserSessionIntegration` ("BrowserSession"). Two reasons the
  // filter was not enough:
  //   1. `integrations` is evaluated ONCE at init, so a mid-session opt-out
  //      left the already-installed integration calling captureSession() on
  //      every route change for the rest of the page's life.
  //   2. It only covered release-health sessions. The default
  //      `browserTracingIntegration()` ALSO emits standalone Web Vital spans
  //      (INP is on by default) whose span name is a DOM tree path —
  //      `htmlTreeAsString(entry.target)`, @sentry-internal/browser-utils's
  //      metrics/inp.js:74 — and those ship via
  //      sendSpanEnvelope() → client.sendEnvelope(), which no beforeSend* hook
  //      can drop.
  // Gating `Client.sendEnvelope`'s single `_transport.send` call covers both,
  // at send time. See lib/sentry/gated-transport.ts for the verified chain.
  transport: gateTransport(Sentry.makeFetchTransport),

  // THE REDACTION MECHANISM — orthogonal to the transport gate above, which
  // drops but never redacts. `beforeSend` sees error events only; transactions
  // and spans get their own hooks (see lib/sentry/scrub.ts — `beforeSendSpan`
  // is where standalone Web Vital spans get their DOM path redacted).
  beforeSend: scrubEvent,
  beforeSendLog: scrubLog,
  beforeSendTransaction: scrubTransaction,
  beforeSendSpan: scrubSpan,
});

// RECONCILE THE SEED AGAINST THE AUTHORITATIVE VALUE — for EVERY session, not
// just the ones that open Settings (the read query in
// lib/queries/crash-report-settings.ts reconciles too, but it only runs on that
// tab). Fire-and-forget on purpose: `Sentry.init` above must stay synchronous
// and must never depend on the local server being reachable. Every failure mode
// is swallowed inside the helper, leaving the init-time seed in place.
//
// Without this, a renderer whose localStorage mirror is missing or stale — a
// privacy-mode write failure at opt-out time, cleared site data, or the server
// coming up on a DIFFERENT PORT (localStorage is origin-keyed to
// `localhost:<port>`) — reads "unset" and reports forever, in direct conflict
// with a persisted "off". See lib/sentry/reconcile-client.ts.
//
// Skipped entirely when SENTRY_ENABLED is false (contributor clone, or the
// kill-switch): that leg sits ABOVE the user preference in
// shouldSendCrashReports()'s precedence chain, so nothing can be sent either
// way and the round-trip would be pure overhead on every page load in dev.
if (SENTRY_ENABLED) void reconcileCrashReportChoiceFromServer();

// CROSS-WINDOW SYNC. The gate is a module-level cache, so it is PER WINDOW:
// opting out in window A left window B (a second Electron window, another tab)
// sending until it reloaded — which, for a desktop app, can be days. The
// `storage` event fires in every OTHER same-origin window when one of them
// writes the mirror, so this makes "takes effect immediately, mid-session" true
// for all of them, not just the one the switch was clicked in.
//
// Scoped to our own key deliberately: a `localStorage.clear()` dispatches an
// event with `key === null`, and treating that as "no preference" would silently
// re-open the gate on a user who had opted out. A cleared mirror is handled by
// the server reconcile above, which still knows the real answer.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== CRASH_REPORTS_STORAGE_KEY) return;
    setCrashReportChoice(readStoredCrashReportChoice());
  });
}

// Instruments App Router client-side navigations for tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
