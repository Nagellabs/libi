// Central Sentry DSN + enablement decision, shared by all three runtime
// configs (client / server / edge).
//
// WHY THE DSN IS COMMITTED HERE
// A Sentry DSN is NOT a secret — it only permits SENDING events, never reading
// them (it ships in plain client JS on every Sentry-instrumented web app).
// Committing it as the default is what makes error tracking work out-of-the-box
// in the two distribution targets that have NO .env file at runtime:
//   - the packaged Electron app, and
//   - the published `npx libi` CLI.
// An env var still overrides it (useful for a staging project or self-hosters).
//
// WHEN IT IS ACTIVE
// Enablement is gated so a CONTRIBUTOR'S working clone never ships local errors
// to the shared project. The launchers (bin/libi.js, the release Next build)
// set NEXT_PUBLIC_LIBI_SENTRY=1 ONLY for genuine end-user installs — keyed off
// the same `.git`-presence signal bin/libi.js already uses to tell a dev
// checkout from an installed package. Default is OFF, so any unforeseen path is
// safe by construction. LIBI_SENTRY_DISABLED=1 is a hard kill-switch that wins.
//
// WHY THE KILL-SWITCH IS READ FROM TWO VAR NAMES
// `LIBI_SENTRY_DISABLED` has no NEXT_PUBLIC_ prefix, so Next.js does not expose
// it to the client bundle at all — read from the browser it evaluated against
// `undefined`, i.e. the "hard kill-switch" silently did nothing in the renderer
// (which is where browser tracing, release-health sessions and DOM-path INP
// spans come from). The launchers therefore MIRROR it into
// `NEXT_PUBLIC_LIBI_SENTRY_DISABLED` (bin/libi.js for `npx libi` / `npm run
// dev`, scripts/next-build-release.js for release builds) and this module
// honours either name.
//
// THE MIRROR IS NOT ENOUGH ON ITS OWN — AND THIS IS WHERE IT USED TO STOP.
// Next INLINES every `NEXT_PUBLIC_*` read at BUILD time; the docs are explicit
// that a built app "will no longer respond to changes to these environment
// variables". So the mirror only takes effect under `next dev`, where the read
// is live. A prebuilt release — `npx @nagellabs/libi` and the packaged app,
// i.e. every real user — carries whatever the BUILD MACHINE had, which is
// never "1". `LIBI_SENTRY_DISABLED=1 npx @nagellabs/libi` therefore silenced
// the server and left the renderer reporting.
//
// The runtime leg that actually closes this lives in `lib/sentry/enabled.ts`:
// the server reports `killSwitched` through `GET /api/settings/crash-reports`
// (already fetched on every page load) and the browser applies it via
// `setServerKillSwitch`. Both legs are kept — the build-time one costs nothing
// and covers the window before the first reconcile resolves.

const DEFAULT_DSN =
  "https://2095803f2d4a0847b90b3d59d9099cc1@o4511551495667712.ingest.us.sentry.io/4511551497699328";

/**
 * Resolved DSN: optional env override (staging / self-host) → committed
 * default. One var is enough: a DSN is public (send-only) and NEXT_PUBLIC_*
 * is readable on the server too, so this single value serves client, server,
 * and edge runtimes alike.
 */
export const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || DEFAULT_DSN;

/**
 * The hard kill-switch. True when EITHER name is `"1"`:
 * - `LIBI_SENTRY_DISABLED` — what a user/operator actually types. Read live at
 *   runtime on the server; invisible to the client bundle (no NEXT_PUBLIC_).
 * - `NEXT_PUBLIC_LIBI_SENTRY_DISABLED` — the launcher-set mirror of the same
 *   value. In the BROWSER this is inlined at build time, so it reflects the
 *   launch command only under `next dev`; the runtime path in
 *   `enabled.ts#setServerKillSwitch` is what carries the switch to a prebuilt
 *   renderer. On the SERVER both names are read live.
 *
 * Either alone is sufficient, so setting only the public name (e.g. in a CI
 * release build) also works.
 */
export const SENTRY_KILL_SWITCHED =
  process.env.LIBI_SENTRY_DISABLED === "1" ||
  process.env.NEXT_PUBLIC_LIBI_SENTRY_DISABLED === "1";

/**
 * Whether Sentry should send events in this process.
 * - Requires a DSN.
 * - Hard kill-switch: LIBI_SENTRY_DISABLED=1 forces off (see
 *   SENTRY_KILL_SWITCHED for why two var names are checked).
 * - Opt-in: NEXT_PUBLIC_LIBI_SENTRY=1 (set by the launchers for real installs;
 *   set it yourself to test from a dev clone).
 *
 * NEXT_PUBLIC_* is inlined at build time for production bundles and read live
 * in `next dev`, so this same expression resolves correctly on both the server
 * and the client in every launch path.
 */
export const SENTRY_ENABLED =
  Boolean(SENTRY_DSN) && !SENTRY_KILL_SWITCHED && process.env.NEXT_PUBLIC_LIBI_SENTRY === "1";

/** Environment tag shown in Sentry (override via NEXT_PUBLIC_LIBI_SENTRY_ENV). */
export const SENTRY_ENVIRONMENT =
  process.env.NEXT_PUBLIC_LIBI_SENTRY_ENV || "production";
