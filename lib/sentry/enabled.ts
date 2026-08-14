// Runtime-agnostic crash-report opt-out gate — shared by the Node server, the
// browser bundle, and the Edge runtime. Same "no Node/DOM APIs" constraint as
// lib/sentry/scrub.ts (see its header): no `node:*` imports, and any `window`
// access is guarded, since this module is imported from all three runtimes.
//
// This module owns two things:
//   1. An in-process CACHE of the user's crash-report choice. Each runtime's
//      Sentry init seeds it once, synchronously, before `Sentry.init()` runs
//      (see sentry.server.config.ts and instrumentation-client.ts), so it can
//      then be read synchronously from lib/sentry/scrub.ts's `beforeSend` /
//      `beforeSendLog` hooks on every subsequent event with no I/O.
//   2. `shouldSendCrashReports()` — the precedence chain that decides whether
//      an event may leave the machine at all.
//
// Declares its own `CrashReportChoice` rather than importing the identical
// type from `lib/db/settings.ts`: that module pulls in `better-sqlite3`
// (Node-only) via `lib/db/client`, and this file must stay importable from
// the browser and Edge bundles. The two literal unions are structurally
// identical (`"unset" | "on" | "off"`), so values flow between them with no
// adapter — `getCrashReportSettings().choice` is assignable here as-is.
import { SENTRY_ENABLED } from "./config";

export type CrashReportChoice = "unset" | "on" | "off";

/** Browser mirror of the preference, so it is readable synchronously at init. */
export const CRASH_REPORTS_STORAGE_KEY = "libi:crash-reports";

/**
 * THE CACHE LIVES ON `globalThis`, NOT IN A MODULE-LEVEL `let`.
 *
 * A bundler may instantiate this module more than once in a single process,
 * and here it demonstrably does: a production `next build` emits TWO server
 * chunks containing `shouldSendCrashReports`, because the API route that
 * writes the choice and the Sentry config that reads it are bundled
 * separately. With module-level state, `PUT /api/settings/crash-reports`
 * wrote one copy while the transport gate and the `beforeSend*` scrubbers read
 * another — so the route's own comment ("without this call … the running
 * server would keep sending crash reports until restart") described exactly
 * what still happened WITH it.
 *
 * Measured in a production build, DSN pointed at a local sink, no browser
 * involved: opting out at runtime and then idling for 70s leaked 4 envelopes —
 * two full transactions, a client report, and an aggregate session. The same
 * server booted with the choice already `"off"` in the DB emitted ZERO. That
 * is the split, not a gap in what the gate covers.
 *
 * Same defect and same remedy as `lib/server/lifecycle/relaunch.ts` — see its
 * header. A `globalThis` slot is process-wide by construction, so every
 * instance shares one answer.
 */
interface CrashReportGateState {
  choice: CrashReportChoice;
  /**
   * Monotonic counter bumped by EVERY write to `choice`. It exists only so an
   * async reconcile can tell whether a newer, more authoritative decision
   * landed while its round-trip was in flight — see
   * `reconcileCrashReportChoice()` for the hazard it closes.
   */
  revision: number;
  /** See `setServerKillSwitch`. */
  serverKillSwitched: boolean;
}

const slot = globalThis as unknown as {
  __libiCrashReportGate?: CrashReportGateState;
};

function gate(): CrashReportGateState {
  if (!slot.__libiCrashReportGate) {
    slot.__libiCrashReportGate = {
      choice: "unset",
      revision: 0,
      serverKillSwitched: false,
    };
  }
  return slot.__libiCrashReportGate;
}

/** Seed the in-process cache. Called by each runtime's Sentry init. */
export function setCrashReportChoice(choice: CrashReportChoice): void {
  const g = gate();
  g.choice = choice;
  g.revision += 1;
}

/**
 * Snapshot the revision BEFORE starting an async read of the persisted
 * preference; hand it back to `reconcileCrashReportChoice()` when the read
 * resolves.
 */
export function getCrashReportChoiceRevision(): number {
  return gate().revision;
}

/**
 * The kill-switch as the SERVER sees it, reported to the browser at runtime.
 *
 * Why this is separate from `SENTRY_KILL_SWITCHED` in config.ts: Next inlines
 * every `NEXT_PUBLIC_*` read at BUILD time, and its docs are explicit that a
 * built app "will no longer respond to changes to these environment
 * variables". A release bundle therefore carries whatever the BUILD MACHINE
 * had, so the launchers' `LIBI_SENTRY_DISABLED` → `NEXT_PUBLIC_…` mirror only
 * takes effect under `next dev`. In a prebuilt `npx @nagellabs/libi` — the
 * flagship install, and the one the published privacy policy (Nagellabs/libi-site)
 * promises this switch works for — the server went silent while the renderer carried on
 * sending errors, sessions, transactions and INP spans.
 *
 * The server knows the flag live, so it reports it through the reconcile
 * endpoint that already runs on every page load. Deliberately NOT written into
 * the stored preference: the switch is an operator override, and folding it
 * into the user's recorded choice would corrupt that choice the moment the
 * switch is lifted.
 */
/** Apply the server's live kill-switch state. Browser-side, from reconcile. */
export function setServerKillSwitch(on: boolean): void {
  gate().serverKillSwitched = on;
}

/** Whether the server has reported the kill-switch as active. */
export function getServerKillSwitch(): boolean {
  return gate().serverKillSwitched;
}

/**
 * Apply a server-persisted choice to the live gate (and the browser mirror),
 * but ONLY if nothing else moved the gate since `revisionAtReadStart`.
 *
 * The DB is authoritative over the localStorage mirror, so a reconcile must be
 * able to move the gate in BOTH directions — a stale/missing mirror that reads
 * `"unset"` (reporting on) has to be corrected down to a persisted `"off"`, and
 * an `"off"` mirror left behind by a since-reversed decision has to be
 * corrected back up to `"on"`. That two-way authority is also what makes the
 * ordering hazard real:
 *
 *   1. Settings mounts; the read query GETs the route → server says `"off"`.
 *   2. Before the response lands, the user flips the switch back ON. The PUT
 *      wins the race, persists `"on"`, and its `onSuccess` moves the gate.
 *   3. The stale GET resolves with `"off"`.
 *
 * Applying step 3 blindly would resurrect an `"off"` the user just turned off —
 * the gate would silently disagree with both the DB and the rendered switch.
 * The revision check makes step 3 a no-op instead: the PUT's
 * `setCrashReportChoice` bumped the counter, so the snapshot no longer matches
 * and the reconcile declines. Whoever wrote last wins, and a write is always
 * newer information than a read that started earlier.
 *
 * @returns whether the value was applied (false ⇒ superseded, deliberately).
 */
export function reconcileCrashReportChoice(
  choice: CrashReportChoice,
  revisionAtReadStart: number,
): boolean {
  if (gate().revision !== revisionAtReadStart) return false;
  setCrashReportChoice(choice);
  writeStoredCrashReportChoice(choice);
  return true;
}

/** Current cached choice. */
export function getCrashReportChoice(): CrashReportChoice {
  return gate().choice;
}

function isCrashReportChoice(value: unknown): value is CrashReportChoice {
  return value === "unset" || value === "on" || value === "off";
}

/**
 * Read the server-injected seed from the HTML, if the page carried one.
 *
 * This is AUTHORITATIVE over the localStorage mirror and available at the same
 * synchronous moment, which is the whole point: `browserSessionIntegration`
 * sends a session-start envelope inside `Sentry.init`, so a value that only
 * arrives with the async reconcile is already too late. The packaged app binds
 * an ephemeral port every launch and localStorage is scoped per origin
 * INCLUDING the port, so an opted-out user's mirror was empty on essentially
 * every launch — one session envelope per launch, forever.
 *
 * Returns `null` when the page carried no seed (a route rendered without the
 * root layout, or an older cached document), leaving the mirror in charge —
 * i.e. exactly the previous behaviour.
 */
export function readInjectedCrashReportConfig(): {
  choice: CrashReportChoice;
  killSwitched: boolean;
} | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = (window as unknown as Record<string, unknown>)[
      "__libiCrashReports"
    ] as { choice?: unknown; killSwitched?: unknown } | undefined;
    if (!raw || !isCrashReportChoice(raw.choice)) return null;
    return { choice: raw.choice, killSwitched: raw.killSwitched === true };
  } catch {
    return null;
  }
}

/** Read the browser mirror. Returns "unset" when absent/unreadable or off-browser. */
export function readStoredCrashReportChoice(): CrashReportChoice {
  if (typeof window === "undefined") return "unset";
  try {
    const raw = window.localStorage.getItem(CRASH_REPORTS_STORAGE_KEY);
    return isCrashReportChoice(raw) ? raw : "unset";
  } catch {
    // Absent storage, a privacy mode that throws on access, or a quota/
    // security error — all resolve to "unset" (i.e. keep reporting; see
    // shouldSendCrashReports()'s default-enabled rule below).
    return "unset";
  }
}

/** Write the browser mirror. No-op off-browser. */
export function writeStoredCrashReportChoice(choice: CrashReportChoice): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CRASH_REPORTS_STORAGE_KEY, choice);
  } catch {
    // Privacy mode / quota error — the mirror silently fails to update, so
    // an explicit "off" the user just chose is NOT visible to the client
    // runtime at its next init (readStoredCrashReportChoice() keeps returning
    // the stale/absent value). The DB-backed server side is unaffected and
    // keeps honouring the real choice. Nothing more is recoverable from HERE —
    // this module does no I/O — but the divergence is no longer permanent:
    // every browser session reconciles against the server-persisted value
    // shortly after init (lib/sentry/reconcile-client.ts, called from
    // instrumentation-client.ts), which re-closes the gate and retries this
    // write. The same path also covers a cleared/origin-changed mirror, where
    // this function succeeded but its value is simply gone.
  }
}

/**
 * Whether a given persisted choice permits sending crash reports: only an
 * explicit `"off"` disables; `"unset"` (not asked yet) and `"on"` both allow.
 * Exported so `lib/db/settings.ts#crashReportsAllowed` can delegate to this
 * instead of re-implementing the `!== "off"` check — same reasoning this
 * file's header already applies to duplicating the `CrashReportChoice`
 * *type* (settings.ts is Node-only, so importing FROM this dependency-light
 * module is the safe direction; the reverse would pull better-sqlite3 into
 * the browser/Edge bundles). Keeps the predicate defined exactly once so a
 * future change to what "allowed" means can't apply to only one side.
 */
export function crashReportChoiceAllowsReporting(choice: CrashReportChoice): boolean {
  return choice !== "off";
}

/**
 * The precedence chain — highest first:
 *   1. The BUILD-TIME view of the kill-switch (`LIBI_SENTRY_DISABLED=1`, plus
 *      the launcher-set `NEXT_PUBLIC_LIBI_SENTRY_DISABLED` mirror) and the
 *      build gate (`NEXT_PUBLIC_LIBI_SENTRY=1`), both folded into
 *      `lib/sentry/config.ts#SENTRY_ENABLED` — reused here rather than
 *      re-reading the env vars, so this file and `config.ts` can never
 *      disagree.
 *   2. The RUNTIME view of the same kill-switch, reported by the server. In a
 *      prebuilt bundle the `NEXT_PUBLIC_*` reads in (1) are frozen to the
 *      build machine's values, so this is the only leg that works in the
 *      browser for a real `npx` install — see `setServerKillSwitch`.
 *   3. The user preference: only an explicit `"off"` disables.
 *   4. Default: `"unset"` behaves as enabled.
 */
export function shouldSendCrashReports(): boolean {
  if (!SENTRY_ENABLED) return false;
  if (getServerKillSwitch()) return false;
  return crashReportChoiceAllowsReporting(getCrashReportChoice());
}
