// lib/analytics/queue.ts
//
// Durable delivery for GA4 events. Every event lands in SQLite before it
// ever touches the network, and only leaves the queue once GA4 has actually
// accepted it (a 2xx from `/g/collect`). libi's "server" is a process on
// the user's own machine that stops the instant they quit — and the most
// valuable events in the funnel are fired by people who are about to do
// exactly that: someone who gives up during agent setup quits DURING the
// step we most need to see. A fire-and-forget `fetch` loses precisely
// those.
//
// Opting out is the one deliberate exception: `drainAnalyticsQueue` clears
// the whole queue the instant `enabled` is false rather than merely
// pausing it — holding events for someone who opted out is exactly the
// behaviour a privacy toggle must not have.

import { asc, count, eq, inArray, lte, sql } from "drizzle-orm";
import { getDb, migrateDatabase } from "@/lib/db/client";
import { analyticsQueue } from "@/lib/db/schema/sqlite";
import { buildCollectUrl, type CollectEvent } from "@/lib/analytics/collect-url";
import { advanceSession, type SessionState } from "@/lib/analytics/identity";
import { sanitizeParams } from "@/lib/analytics/events";
import {
  getAnalyticsSettings,
  getOrCreateAnalyticsUserId,
  markAnalyticsMilestoneOnce,
} from "@/lib/db/settings";
import type { AnalyticsSettings } from "@/lib/analytics/settings-logic";
import {
  ANALYTICS_DEBUG,
  ANALYTICS_ENABLED,
  ANALYTICS_KILL_SWITCH,
  MEASUREMENT_ID,
} from "@/lib/analytics/config";
import { isTestMode } from "@/lib/test-mode";
import { serverLogger as logger } from "@/lib/logger";

export const MAX_QUEUE_ROWS = 500;
export const MAX_ATTEMPTS = 8;
export const DRAIN_INTERVAL_MS = 15_000;
export const DRAIN_BATCH = 20;

export interface DrainDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  getSettings?: () => AnalyticsSettings;
  /** Injected so the first-visit test can drive the milestone without
   *  reaching into persisted settings. Defaults to the real, PERSISTED
   *  primitive — see FIRST_HIT_MILESTONE below for why that matters. */
  markMilestoneOnce?: (name: string) => boolean;
}

export interface DrainResult {
  sent: number;
  failed: number;
  dropped: number;
}

/** Exponential backoff for retrying a failed send: 30s, 60s, 120s, ... —
 *  capped at an hour so a long-offline install still retries on a sane
 *  cadence instead of hammering a dead network. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** (attempts - 1), 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Module-level, in-process state
// ---------------------------------------------------------------------------
//
// Session state is intentionally NOT persisted: a process restart
// legitimately starts a new GA4 session (see lib/analytics/identity.ts).
// Durability lives entirely in the `analytics_queue` table — never in a
// module-level cache of pending rows, which a restart would silently drop.

let sessionState: SessionState | null = null;
/** Distinct non-2xx statuses already warned about, so a persistently
 *  broken endpoint logs once instead of once per queued event. */
let loggedStatuses = new Set<number>();
let drainTimer: ReturnType<typeof setInterval> | null = null;
/** The drain currently outstanding, or null. See `runScheduledDrain`. */
let drainInFlight: Promise<void> | null = null;
let testDbReady = false;

/** The persisted milestone behind GA4's `_fv` (first visit) flag.
 *
 *  This USED to be a module-level `hasAttemptedAnyHit` boolean, whose own
 *  comment admitted it only approximated "first hit this install ever sent"
 *  — it reset with the process. GA4 derives New Users from `_fv`, so every
 *  relaunch of libi registered a brand-new user and the funnel's denominator
 *  inflated over the life of an install. `markAnalyticsMilestoneOnce` is the
 *  already-built persisted primitive for exactly this.
 *
 *  Its own name, deliberately: `"launch"` and `"first_message"` are taken and
 *  mean other things. */
export const FIRST_HIT_MILESTONE = "analytics_first_hit";

/** Test-only: lazily migrate a real, file-backed DB so unit tests here —
 *  which have no lifecycle prelude to do it for them — have a table to
 *  exercise. Deliberately NOT called from enqueue/drain: production
 *  migrates via lib/server/lifecycle, and this module must not duplicate
 *  that (a second migrateDatabase() call there would re-run backupDb()
 *  for no reason). */
function ensureTestDbReady(): void {
  if (testDbReady) return;
  testDbReady = true;
  try {
    migrateDatabase();
  } catch {
    // Already migrated (idempotent), or some other caller owns it — either
    // way there's nothing for this test helper to do about it.
  }
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/** Queue one analytics event for later delivery. Synchronous and total: it
 *  never throws and never awaits, so a caller measuring a flow can never be
 *  taken down by analytics.
 *
 *  Three different gates apply here, and they are NOT interchangeable:
 *   - isTestMode(): test-mode runs must not pollute real GA4 data.
 *   - ANALYTICS_KILL_SWITCH (LIBI_ANALYTICS_DISABLED=1): the user's hard
 *     kill-switch. A kill-switch that still writes rows to disk — even rows
 *     that will never be sent, because nothing clears them without the
 *     drain — is not a kill-switch, so this one stops recording, not just
 *     sending.
 *   - getAnalyticsSettings().enabled: the in-app opt-out toggle. Same
 *     reasoning — an opted-out user must not accumulate analytics data on
 *     disk just because the build that happens to be running never starts
 *     the drain that would otherwise clear the table.
 *
 *  ANALYTICS_ENABLED, by contrast, is deliberately NOT checked here. It is
 *  the build-time install flag (see lib/analytics/config.ts) and gates only
 *  startAnalyticsDrain below — the chokepoint that actually reaches the
 *  network. Queuing itself is cheap and reversible — capped at
 *  MAX_QUEUE_ROWS by evicting the oldest rows — so keeping it ungated on
 *  the build flag here is the "lose fewer events" choice: an event queued
 *  before a restart that flips the flag on is still there to send. */
export function enqueueAnalyticsEvent(name: string, params?: Record<string, unknown>): void {
  try {
    if (isTestMode() || ANALYTICS_KILL_SWITCH) return;
    // A settings-read failure falls through to the outer catch below, which
    // skips the write — the safe default when we can't tell whether the
    // user opted out.
    if (!getAnalyticsSettings().enabled) return;

    const clean = sanitizeParams(params);
    const db = getDb();
    db.insert(analyticsQueue)
      .values({
        id: crypto.randomUUID(),
        name,
        paramsJson: JSON.stringify(clean),
        // Always immediately due — a brand-new event has never failed yet,
        // so there is no backoff to honor.
        nextAttemptAt: new Date(0),
      })
      .run();

    // Cheap on the common path: only the row count is read here. The id
    // list is fetched (bounded by LIMIT) only on the rare over-cap branch.
    const [{ n }] = db.select({ n: count() }).from(analyticsQueue).all();
    if (n > MAX_QUEUE_ROWS) {
      const excess = db
        .select({ id: analyticsQueue.id })
        .from(analyticsQueue)
        .orderBy(asc(analyticsQueue.createdAt))
        .limit(n - MAX_QUEUE_ROWS)
        .all()
        .map((r) => r.id);
      db.delete(analyticsQueue).where(inArray(analyticsQueue.id, excess)).run();
    }
  } catch {
    // Total: analytics must never be the reason a caller's own flow breaks.
  }
}

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

/** Attempt to deliver queued events to GA4. Reads the opt-out setting once,
 *  up front: if analytics is disabled the WHOLE queue is dropped (not
 *  merely paused — see module doc) and nothing is sent. Otherwise, up to
 *  DRAIN_BATCH due rows are sent in order, advancing the in-process GA4
 *  session once per actual send attempt so `_s` matches hits on the wire. */
export async function drainAnalyticsQueue(deps: DrainDeps = {}): Promise<DrainResult> {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getSettings = deps.getSettings ?? getAnalyticsSettings;
  const markMilestoneOnce = deps.markMilestoneOnce ?? markAnalyticsMilestoneOnce;

  const db = getDb();
  const settings = getSettings();

  if (!settings.enabled) {
    const rows = db.select({ id: analyticsQueue.id }).from(analyticsQueue).all();
    if (rows.length > 0) db.delete(analyticsQueue).run();
    return { sent: 0, failed: 0, dropped: rows.length };
  }

  const nowMs = now();
  const due = db
    .select()
    .from(analyticsQueue)
    .where(lte(analyticsQueue.nextAttemptAt, new Date(nowMs)))
    // nextAttemptAt/createdAt are millisecond-resolution, so two events
    // queued in the same millisecond would otherwise have no defined
    // order. `rowid` is SQLite's own monotonically-increasing insertion
    // order for this table (no WITHOUT ROWID), so it's a free, exact
    // tiebreaker rather than one relying on query-plan incidence.
    .orderBy(asc(analyticsQueue.nextAttemptAt), asc(analyticsQueue.createdAt), asc(sql`rowid`))
    .limit(DRAIN_BATCH)
    .all();

  let sent = 0;
  let failed = 0;
  let dropped = 0;
  // Asked at most once per drain, and only when there is a row to attach it
  // to — an empty batch must not burn the milestone, and a 20-row batch has
  // no reason to re-read settings twenty times.
  let firstVisitAsked = false;
  const userId = settings.userId ?? getOrCreateAnalyticsUserId();

  for (const row of due) {
    const { state, sessionStart } = advanceSession(sessionState, nowMs);
    sessionState = state;
    // Persisted, not per-process: `_fv` is how GA4 counts New Users, so a
    // per-process flag made every relaunch look like a new install. Total by
    // construction — a settings failure must never cost us the hit, so it
    // just means we don't claim first-visit.
    let firstVisit = false;
    if (!firstVisitAsked) {
      firstVisitAsked = true;
      try {
        firstVisit = markMilestoneOnce(FIRST_HIT_MILESTONE);
      } catch {
        firstVisit = false;
      }
    }

    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(row.paramsJson) as Record<string, unknown>;
    } catch {
      params = {};
    }

    const ev: CollectEvent = {
      name: row.name,
      // Sanitized once already at enqueue time, into paramsJson. Sanitizing
      // again here is deliberate defense-in-depth against a hand-edited or
      // older row whose paramsJson predates a sanitization rule change —
      // sanitizeParams is idempotent, so this is a no-op on the common path.
      params: sanitizeParams(params),
      clientId: userId,
      userId,
      sessionId: state.sessionId,
      hitNumber: state.hitNumber,
      sessionStart,
      firstVisit,
      debug: ANALYTICS_DEBUG,
      // These are background/queued hits, not a live timed user session —
      // there's no real engagement span to report, so send the floor value
      // buildCollectUrl would clamp to anyway.
      engagementMs: 1,
    };
    const url = buildCollectUrl(ev, MEASUREMENT_ID);

    let ok = false;
    let status: number | null = null;
    try {
      const res = await fetchImpl(url, { method: "POST", signal: AbortSignal.timeout(5000) });
      ok = res.ok;
      status = res.status;
    } catch {
      ok = false;
    }

    if (ok) {
      db.delete(analyticsQueue).where(eq(analyticsQueue.id, row.id)).run();
      sent++;
      continue;
    }

    // Non-2xx is the one mitigation for `/g/collect` being undocumented: if
    // Google changes it, our own logs say so — once per distinct status,
    // not once per event.
    if (status !== null && !loggedStatuses.has(status)) {
      loggedStatuses.add(status);
      logger.warn(
        { tag: "analytics", op: "collect_rejected", status },
        "GA4 /g/collect rejected an event",
      );
    }

    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      db.delete(analyticsQueue).where(eq(analyticsQueue.id, row.id)).run();
      dropped++;
      logger.warn(
        { tag: "analytics", op: "event_dropped", name: row.name, attempts },
        "Dropping analytics event after exhausting retries",
      );
    } else {
      db.update(analyticsQueue)
        .set({ attempts, nextAttemptAt: new Date(nowMs + backoffMs(attempts)) })
        .where(eq(analyticsQueue.id, row.id))
        .run();
      failed++;
    }
  }

  return { sent, failed, dropped };
}

// ---------------------------------------------------------------------------
// Interval driver
// ---------------------------------------------------------------------------

/** Start the periodic drain. Idempotent — a second call while already
 *  running is a no-op. Drains immediately, then every DRAIN_INTERVAL_MS.
 *  The interval is unref'd so it can never keep the process alive on its
 *  own. No-ops entirely when ANALYTICS_ENABLED is false — this is the
 *  chokepoint that keeps a local dev build (analytics off by default) from
 *  ever reaching the real network; see the note on enqueueAnalyticsEvent
 *  above for why the gate lives here and not at enqueue time. */
export function startAnalyticsDrain(deps: DrainDeps = {}): void {
  if (!ANALYTICS_ENABLED || drainTimer) return;
  runScheduledDrain(deps);
  drainTimer = setInterval(() => runScheduledDrain(deps), DRAIN_INTERVAL_MS);
  drainTimer.unref?.();
}

/**
 * One scheduled drain tick, with a module-level in-flight guard.
 *
 * The interval used to fire `drainAnalyticsQueue()` without awaiting the
 * previous one, and rows are NOT reserved: the SELECT filters only on
 * `nextAttemptAt <= now`, and a row is deleted (or backed off) only AFTER its
 * send resolves. With DRAIN_BATCH = 20 rows sent SERIALLY, GA4 answering in a
 * perfectly ordinary ~1s means a batch takes 20s against a 15s interval — so
 * the next tick selected the same still-unresolved rows and POSTed them
 * again. On a degraded link (the 5s `AbortSignal.timeout`) one batch runs
 * ~100s, i.e. up to seven concurrent drains replaying one queue.
 * `/g/collect` has no idempotency, so every duplicate counts — and
 * over-reporting looks like healthy numbers, so nothing surfaces it. A fresh
 * install, the exact case the funnel exists to measure, fills the queue
 * fastest.
 *
 * Skipping (rather than queueing) the tick is right: the work is not lost,
 * the next interval picks up whatever is still due.
 */
export function runScheduledDrain(deps: DrainDeps = {}): Promise<void> {
  if (drainInFlight) return drainInFlight;
  const pass: Promise<void> = drainAnalyticsQueue(deps)
    .then(() => undefined)
    .catch((err) => {
      logger.warn({ tag: "analytics", op: "drain_failed", err }, "Analytics drain failed");
    })
    .finally(() => {
      if (drainInFlight === pass) drainInFlight = null;
    });
  drainInFlight = pass;
  return pass;
}

/** Stop the periodic drain. For tests. */
export function stopAnalyticsDrain(): void {
  if (drainTimer) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Test support
// ---------------------------------------------------------------------------

/** Clears the queue table, the in-process session state, and the logged-
 *  status set. Test-only. Also lazily migrates a real, file-backed test DB
 *  the first time it's called — unit tests here have no lifecycle prelude
 *  to do that for them, and it must be a real DB on disk (not an in-memory
 *  module cache) for the restart-durability test to prove anything. */
export function __resetAnalyticsQueueForTests(): void {
  ensureTestDbReady();
  getDb().delete(analyticsQueue).run();
  sessionState = null;
  drainInFlight = null;
  loggedStatuses = new Set<number>();
}
