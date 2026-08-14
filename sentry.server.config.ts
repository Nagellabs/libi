// Sentry — Node.js server runtime.
// Loaded from instrumentation.ts when NEXT_RUNTIME === "nodejs".
//
// Privacy posture (see lib/sentry/scrub.ts for the full rationale):
//   - sendDefaultPii: false      → no IP / headers / cookies / bodies attached
//   - includeLocalVariables: false → stack frames never capture local values
//     (those routinely hold API keys/tokens)
//   - beforeSend / beforeSendLog → scrub identity + secrets before anything ships
//   - beforeSendTransaction / beforeSendSpan → same gate + scrub for
//     performance-tracing data, which `beforeSend` never sees (error events
//     only) — see lib/sentry/scrub.ts for why beforeSendSpan is scrub-only
//   - transport: gateTransport(...) → the DROP mechanism. Refuses the network
//     request, per envelope, while the user has opted out. Covers every
//     envelope type including the ones no beforeSend* hook can stop
//     (release-health sessions, standalone spans). See lib/sentry/gated-transport.ts.
// We never call Sentry.setUser(), so events carry no user identity.
import fs from "node:fs";
import os from "node:os";
import * as Sentry from "@sentry/nextjs";

import { getCrashReportSettings } from "./lib/db/settings";
import { getLibiDbPath } from "./lib/libi-home";
import { SENTRY_DSN, SENTRY_ENABLED, SENTRY_ENVIRONMENT } from "./lib/sentry/config";
import { setCrashReportChoice } from "./lib/sentry/enabled";
import { gateTransport } from "./lib/sentry/gated-transport";
import {
  registerSensitiveValues,
  scrubEvent,
  scrubLog,
  scrubSpan,
  scrubTransaction,
} from "./lib/sentry/scrub";

// Tell the scrubber this machine's literal identifiers, so it can censor forms
// no pattern can anticipate: a slugified home path, and the per-user token in
// the macOS temp dir (`/var/folders/<a>/<per-user hash>/T`) — which is exactly
// where the export backends do their work, so export crashes carry it.
// Must run BEFORE Sentry.init so the very first event is already covered.
registerSensitiveValues({
  paths: [os.homedir(), os.tmpdir(), process.env.LIBI_HOME],
  userNames: [os.userInfo().username],
});

/** True when the sqlite file exists AND is non-empty — i.e. migrations have
 *  already run at least once, so querying a table is safe. A 0-byte file is
 *  what better-sqlite3 leaves behind when anything opens the connection before
 *  the first migration; querying THAT throws `no such table`. */
function dbFileHasContent(p: string): boolean {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

// Seed the crash-report gate (lib/sentry/enabled.ts) from the persisted user
// preference BEFORE Sentry.init, so the very first event in this process is
// already governed. getCrashReportSettings() is synchronous (better-sqlite3),
// so there is no race between this read and the first captured event.
//
// Guarded twice:
//   1. This file runs at server boot, BEFORE Category B migrates the DB, and
//      potentially before the DB file itself exists (a genuinely first-ever
//      run). getDb()/better-sqlite3 CREATES the file on open with no
//      `fileMustExist` guard, and that 0-byte file then gets caught by
//      migrateDatabase()'s backupDb() as if it were a real pre-existing DB —
//      wasting one of only 3 backup slots and logging a misleading "Database
//      backed up to …" on a fresh install. So this read is skipped unless the
//      DB file is on disk AND has content. An `existsSync`-only check was not
//      enough: on a clean-prefix install of the npm tarball the file is
//      already present-but-EMPTY by the time this runs, so the read reached
//      the query and threw `no such table: settings`, taking the catch below
//      and printing a WARN about a reverted opt-out to every user on their
//      very first boot — when no preference had ever been stored. Note that
//      skipping does NOT enter the catch below and logs nothing: the gate
//      simply keeps lib/sentry/enabled.ts's initial `cachedChoice = "unset"`
//      value, which shouldSendCrashReports() treats as enabled (the
//      documented fresh-install default).
//   2. Even when the file exists, the read can still fail (locked, mid
//      schema-change) — the same ordering hazard analytics init was
//      deliberately placed after migrations to avoid. A failed read here
//      must not crash boot, so it falls back to "unset" (i.e. keep
//      reporting, the default) and logs a warning so a user who explicitly
//      chose "off" and got silently reverted to reporting has something to
//      grep for.
try {
  if (dbFileHasContent(getLibiDbPath())) {
    setCrashReportChoice(getCrashReportSettings().choice);
  }
} catch (err) {
  setCrashReportChoice("unset");
  // Dynamic import: this file is walked by the Edge bundler too (see
  // instrumentation.ts's header), and `@/lib/logger` pulls in pino +
  // filesystem setup that has no business in that bundle. Fire-and-forget —
  // logging must never gate or delay Sentry.init.
  void import("@/lib/logger")
    .then(({ serverLogger }) => {
      serverLogger.warn(
        { tag: "sentry", op: "crash_report_seed_failed", err },
        "Failed to read the persisted crash-report preference at boot — defaulting to enabled",
      );
    })
    .catch(() => {
      /* logging is best-effort — swallow */
    });
}

Sentry.init({
  // Committed public DSN, gated by SENTRY_ENABLED. See lib/sentry/config.ts.
  dsn: SENTRY_DSN,
  enabled: SENTRY_ENABLED,
  environment: SENTRY_ENVIRONMENT,

  sendDefaultPii: false,
  includeLocalVariables: false,

  // Low-rate performance tracing (slow-operation visibility without volume).
  tracesSampleRate: 0.1,

  // Ship structured logs into Sentry (you already use pino — keep its
  // `redact` paths configured so secrets are stripped at the source too).
  enableLogs: true,

  // THE DROP MECHANISM for the opt-out. Wraps the SDK's own default Node
  // transport so that, per envelope, nothing is sent while the user has
  // opted out. This deliberately replaced an earlier `integrations` override
  // that dropped the `Http` integration's `trackIncomingRequestsAsSessions`:
  // release-health sessions bypass every beforeSend* hook, but `integrations`
  // is evaluated ONCE at init, so a mid-session opt-out left the already
  // installed integration emitting sessions for the rest of the process — days,
  // on a desktop app. Gating the transport instead is evaluated at SEND time,
  // so the preference is live with no reload, and it covers EVERY envelope
  // type (sessions, standalone spans, client reports, check-ins, …) rather
  // than the one integration we thought to name. The default integration set
  // is now left untouched. Rationale + verified SDK call chain:
  // lib/sentry/gated-transport.ts.
  transport: gateTransport(Sentry.makeNodeTransport),

  // THE REDACTION MECHANISM — orthogonal to the transport gate above, which
  // drops but never redacts. `beforeSend` sees error events only; transactions
  // and spans get their own hooks (see lib/sentry/scrub.ts, incl. why
  // beforeSendSpan is scrub-only and where standalone spans land).
  beforeSend: scrubEvent,
  beforeSendLog: scrubLog,
  beforeSendTransaction: scrubTransaction,
  beforeSendSpan: scrubSpan,
});
