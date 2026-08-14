// Server-side: the inline `<head>` script that seeds the browser's
// crash-report gate SYNCHRONOUSLY, before any client JS runs.
//
// ── Why localStorage alone is not enough ──────────────────────────────────
// `instrumentation-client.ts` seeds the gate from the localStorage mirror
// because that is the only store readable with no I/O before the first event
// can fire. But `browserSessionIntegration` sends a session-start envelope
// SYNCHRONOUSLY inside `Sentry.init` — before the async reconcile against the
// server can possibly resolve — so anything the mirror does not know is
// already reported by the time the truth arrives.
//
// And the mirror is empty far more often than it looks. The packaged app binds
// an EPHEMERAL port every launch (`listen(0)`), and localStorage is scoped per
// origin INCLUDING the port, so `localhost:51234` and `localhost:51235` are
// different stores. A user who opted out got a fresh, empty mirror on
// essentially every launch — one session envelope per launch, forever.
//
// The server knows the persisted choice with no round-trip, so it writes it
// into the HTML. That closes the window for every origin and every profile,
// not just the ones that happen to have a warm mirror.
//
// The kill-switch rides along for a different reason: Next inlines
// `NEXT_PUBLIC_*` at build time, so a prebuilt renderer cannot see
// `LIBI_SENTRY_DISABLED` at all (see lib/sentry/config.ts). Injecting it here
// makes the switch effective from the first client instruction rather than
// from whenever `/api/settings/crash-reports` answers.

/** Shape written onto `window`. Read by `enabled.ts#readInjectedCrashReportConfig`. */
export const CRASH_REPORT_SEED_GLOBAL = "__libiCrashReports";

/**
 * The script body. Pure string building — no DB, no env reads — so it is
 * trivially testable and the caller owns where the values come from.
 *
 * `choice` is constrained to the three known literals by the caller; it is
 * re-validated here anyway because this string is interpolated into HTML.
 */
export function crashReportSeedScript(opts: {
  choice: string;
  killSwitched: boolean;
}): string {
  const choice =
    opts.choice === "on" || opts.choice === "off" || opts.choice === "unset"
      ? opts.choice
      : "unset";
  return (
    `window.${CRASH_REPORT_SEED_GLOBAL}=` +
    `{choice:"${choice}",killSwitched:${opts.killSwitched ? "true" : "false"}};`
  );
}
