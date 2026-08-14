// Browser-only: bring the live crash-report gate back in line with the
// DB-persisted preference, shortly after `Sentry.init`.
//
// WHY THIS EXISTS. The client gate is seeded synchronously at init from the
// localStorage mirror, because that is the only store readable with no I/O
// before the first event can fire (see instrumentation-client.ts). The mirror
// is a cache, not the record — the DB is authoritative — and it can be wrong in
// ways that all fail OPEN, i.e. towards reporting:
//
//   * the mirror WRITE failed at opt-out time (a privacy mode that throws on
//     localStorage — the divergence documented in enabled.ts#writeStoredCrashReportChoice);
//   * the user cleared site data;
//   * the server came up on a different port, so `localhost:<port>` is a
//     DIFFERENT origin with its own empty localStorage.
//
// In every one of those the mirror reads `"unset"`, which the gate treats as
// enabled — so a user who opted out would keep reporting on every subsequent
// launch, forever, with nothing to correct it. Worse, opening Settings → Privacy
// in that state renders the switch OFF from server data while the very same
// renderer keeps shipping envelopes: the UI would be lying about the live gate.
// The privacy policy's promise that stopping future collection "always works"
// requires closing this loop.
//
// Deliberately NOT part of Sentry.init: init must stay synchronous and must not
// depend on the local server being up. This is fire-and-forget, silent on every
// failure, and merely narrows an already-disclosed default-on window from
// "forever" to "the few hundred ms until the server answers".
import {
  getCrashReportChoiceRevision,
  reconcileCrashReportChoice,
  setServerKillSwitch,
  type CrashReportChoice,
} from "./enabled";

const ENDPOINT = "/api/settings/crash-reports";

function asChoice(value: unknown): CrashReportChoice | null {
  return value === "unset" || value === "on" || value === "off" ? value : null;
}

/**
 * Fetch the persisted choice and apply it to the live gate + the localStorage
 * mirror. Never throws, never rejects.
 *
 * The revision is snapshotted BEFORE the request so that a user decision made
 * while it is in flight wins — see enabled.ts#reconcileCrashReportChoice for
 * that ordering hazard.
 */
export async function reconcileCrashReportChoiceFromServer(): Promise<void> {
  if (typeof window === "undefined") return;
  const revision = getCrashReportChoiceRevision();
  try {
    const res = await fetch(ENDPOINT);
    if (!res.ok) return;
    const body: unknown = await res.json();

    // The operator kill-switch, as the SERVER sees it. Applied unconditionally
    // and BEFORE the choice: there is no user decision to race here (it is an
    // env var, not a preference), and it is the only leg that carries
    // `LIBI_SENTRY_DISABLED=1` into a PREBUILT renderer — Next inlines
    // `NEXT_PUBLIC_*` at build time, so the launcher's mirror reaches the
    // browser only under `next dev`. Kept out of the stored preference so
    // lifting the switch restores the user's real choice untouched.
    setServerKillSwitch((body as { killSwitched?: unknown } | null)?.killSwitched === true);

    const choice = asChoice((body as { choice?: unknown } | null)?.choice);
    if (!choice) return;
    reconcileCrashReportChoice(choice, revision);
  } catch {
    // Server not up yet, offline, HTML error page, aborted navigation — all
    // leave the init-time seed in place, which is the documented default-on
    // behaviour. A failed reconcile must never break the page or the SDK.
  }
}
