/**
 * Tell the public catalog that an installed template was used — the numbers
 * behind its "uses" and trending. Modeled on lib/analytics/queue.ts, but it is
 * NOT analytics: the privacy policy (libi-site, §5.5) says a use notice is sent
 * automatically, whether or not product analytics is on, with no setting to
 * turn it off, and that it names the template and carries nothing else. So
 * nothing here reads an analytics setting, and what goes out is exactly
 * `reportUse(cloudId)` — `POST /api/templates/<id>/use`, body `{}`, no account
 * (lib/templates/cloud/client.ts).
 *
 * Which uses: rows of `template_uses` whose template has `origin: "installed"`
 * (installed from the catalog — someone else's). A local-only template never
 * reports, and neither does the user's own published template used from its
 * local row (origin "local"): the policy speaks of templates "you installed
 * from the catalog".
 *
 * And only to the catalog the template came from: a use goes out to catalog S
 * only when its template was installed from S AND the use was recorded for S
 * (lib/templates/store.ts#recordUse records an installed template's own
 * catalog, and test mode's own marker in test mode). Each pass drains every
 * catalog this process may reach (catalog-setting.ts#reachableCatalogSources):
 * a packaged build its own site; a dev build both the production and its
 * development catalog, so a use of a template installed from Development is
 * still reported there after a switch to Production; test mode the fixture.
 * Test mode shares LIBI_HOME with a normal boot, so a test-mode use never
 * reaches the real site, or a real one the fixture. A catalog out of reach
 * keeps its rows unreported — the truth — and they are never deleted.
 *
 * The rows are the queue. `reported` flips to true once the catalog answered
 * for the use; `report_attempts` / `report_next_at` hold the backoff, so it
 * survives a restart. A row is sent from 30 s after the use until 7 days after
 * it; older, it is never selected again and stays `reported = false`, which is
 * the truth.
 *
 * Batched per cloudId: one notice covers every due use of a template in a
 * pass. The site counts at most one use per client per template per UTC day,
 * answering a repeat exactly like a counted use, so a second notice for the
 * same template in the same pass could never count — it would only spend the
 * site's 30-per-minute budget.
 *
 * One sender per row. The drain runs in the Next server (instrumentation.ts),
 * never the MCP child — but two libi servers can share one LIBI_HOME (npx and
 * the desktop app), so before sending, a pass CLAIMS its rows by moving
 * `report_next_at` CLAIM_MS ahead in one UPDATE, which SQLite serialises: a
 * row another pass has claimed, or that is backing off, is not due. A process
 * that dies mid-send leaves a claim that simply expires; the resend is
 * harmless, because the site de-duplicates per day.
 *
 * Answers:
 *  - ok → the rows are reported.
 *  - 404 `not_found` (hidden or unknown on the site) → done: the rows leave
 *    the queue (marked reported, never deleted — they are also the local use
 *    history behind `uses7d`).
 *  - 503 `contended` → retry after its `Retry-After`; contention is not the
 *    catalog failing, so it does not grow the backoff.
 *  - anything else → the template's rows back off together, exponentially
 *    (30 s doubling, capped at an hour), and never sooner than a
 *    `Retry-After` (capped the same).
 */
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lte, max, notInArray, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { templateUses, templates } from "@/lib/db/schema/sqlite";
import { serverLogger as logger } from "@/lib/logger";
import { PRODUCTION_SITE_URL } from "@/lib/site-url";
import { reachableCatalogSources } from "@/lib/templates/cloud/catalog-setting";
import { catalogSource, withCatalogSource } from "@/lib/templates/cloud/catalog-source";
import { type CloudFail, isNoSuchTemplate, reportUse as reportUseToSite } from "@/lib/templates/cloud/client";
import { linkedToThisCatalog } from "@/lib/templates/store";

export const REPORT_DELAY_MS = 30_000;
export const GIVE_UP_MS = 7 * 86_400_000;
export const DRAIN_INTERVAL_MS = 60_000;
export const DRAIN_BATCH = 20;
/** How long a pass holds a row it is sending: well past the client's 15 s call timeout. */
export const CLAIM_MS = 5 * 60_000;
const MAX_WAIT_MS = 60 * 60 * 1000;
const TAG = "templates-cloud";

/** SQL: the use was made against this catalog (a null source, from before sources were recorded, is production's). */
function madeAgainstThisCatalog() {
  return sql`coalesce(${templateUses.source}, ${PRODUCTION_SITE_URL}) = ${catalogSource()}`;
}

export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** (attempt - 1), MAX_WAIT_MS);
}

interface Deps {
  now?: () => number;
  reportUse?: typeof reportUseToSite;
}

export interface DrainResult {
  /** Uses the catalog answered for: counted, a same-day repeat, or no such template (done). */
  sent: number;
  /** Uses whose notice failed this pass; they back off. */
  failed: number;
  /** Due uses left alone: their template is backing off, or another pass holds them. */
  skipped: number;
}

let timer: ReturnType<typeof setInterval> | null = null;
let firstPass: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
/** A drain that fails every pass (a broken DB) warns once, then logs at debug until a pass succeeds. */
let drainFailing = false;

/**
 * One pass over every catalog this process may reach, each pinned to its own
 * catalog (`withCatalogSource`): the SQL below, the notice's address and the
 * development site's bypass header all follow it.
 */
export async function drainUseReports(deps: Deps = {}): Promise<DrainResult> {
  const total: DrainResult = { sent: 0, failed: 0, skipped: 0 };
  for (const source of reachableCatalogSources()) {
    const r = await withCatalogSource(source, () => drainCatalog(deps));
    total.sent += r.sent;
    total.failed += r.failed;
    total.skipped += r.skipped;
  }
  return total;
}

async function drainCatalog(deps: Deps): Promise<DrainResult> {
  const clock = deps.now ?? Date.now;
  const report = deps.reportUse ?? reportUseToSite;
  const db = getDb();
  const now = clock();

  // Unreported uses of templates installed from this catalog, made against it, inside the reporting window.
  const inWindow = and(
    eq(templateUses.reported, false),
    eq(templates.origin, "installed"),
    isNotNull(templates.cloudId),
    linkedToThisCatalog(),
    madeAgainstThisCatalog(),
    lte(templateUses.usedAt, new Date(now - REPORT_DELAY_MS)),
    gte(templateUses.usedAt, new Date(now - GIVE_UP_MS)),
  );
  // A template waits as a whole while any of its due rows waits (backoff or another pass's claim).
  const waiting = db
    .selectDistinct({ templateId: templateUses.templateId })
    .from(templateUses)
    .innerJoin(templates, eq(templateUses.templateId, templates.id))
    .where(and(inWindow, gt(templateUses.reportNextAt, new Date(now))))
    .all()
    .map((r) => r.templateId);
  let skipped = 0;
  if (waiting.length > 0) {
    const [{ n }] = db
      .select({ n: sql<number>`count(*)` })
      .from(templateUses)
      .innerJoin(templates, eq(templateUses.templateId, templates.id))
      .where(and(inWindow, inArray(templateUses.templateId, waiting)))
      .all();
    skipped = Number(n);
  }
  const due = db
    .select({ id: templateUses.id, templateId: templateUses.templateId, cloudId: templates.cloudId })
    .from(templateUses)
    .innerJoin(templates, eq(templateUses.templateId, templates.id))
    .where(waiting.length > 0 ? and(inWindow, notInArray(templateUses.templateId, waiting)) : inWindow)
    .orderBy(asc(templateUses.usedAt), asc(sql`${templateUses}.rowid`))
    .limit(DRAIN_BATCH)
    .all();

  const groups = new Map<string, { cloudId: string; ids: string[] }>();
  for (const row of due) {
    if (!row.cloudId) continue;
    const g = groups.get(row.templateId) ?? { cloudId: row.cloudId, ids: [] };
    g.ids.push(row.id);
    groups.set(row.templateId, g);
  }

  let sent = 0;
  let failed = 0;
  for (const [templateId, { cloudId, ids }] of groups) {
    const t = clock();
    const free = or(isNull(templateUses.reportNextAt), lte(templateUses.reportNextAt, new Date(t)));
    const claimed = db
      .update(templateUses)
      .set({ reportNextAt: new Date(t + CLAIM_MS) })
      .where(and(inArray(templateUses.id, ids), eq(templateUses.reported, false), free))
      .returning({ id: templateUses.id })
      .all()
      .map((r) => r.id);
    skipped += ids.length - claimed.length;
    if (claimed.length === 0) continue;

    const r = await report(cloudId).catch((err: unknown): CloudFail => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    const at = clock();
    const mine = inArray(templateUses.id, claimed);
    // The template's other unreported rows, inside the window, that no other pass holds.
    // Rows past GIVE_UP_MS are never touched again, not even to share a backoff.
    const rest = and(
      eq(templateUses.templateId, templateId),
      eq(templateUses.reported, false),
      madeAgainstThisCatalog(),
      gte(templateUses.usedAt, new Date(now - GIVE_UP_MS)),
      or(isNull(templateUses.reportNextAt), lte(templateUses.reportNextAt, new Date(at))),
    );

    if (r.ok || isNoSuchTemplate(r)) {
      db.transaction((tx) => {
        tx.update(templateUses).set({ reported: true, reportAttempts: 0, reportNextAt: null }).where(mine).run();
        // A success ends the template's backoff: a later failure starts over at 30 s.
        tx.update(templateUses).set({ reportAttempts: 0, reportNextAt: null }).where(and(rest, gt(templateUses.reportAttempts, 0))).run();
      });
      sent += claimed.length;
      if (!r.ok) logger.info({ tag: TAG, op: "use_report_template_gone", cloudId, uses: claimed.length }, "catalog no longer lists this template; its uses leave the queue");
      continue;
    }

    const [{ prior }] = db.select({ prior: max(templateUses.reportAttempts) }).from(templateUses).where(mine).all();
    const priorAttempts = prior ?? 0;
    const retryAfter = r.retryAfterMs === undefined ? undefined : Math.min(r.retryAfterMs, MAX_WAIT_MS);
    const contended = r.code === "contended";
    const attempts = contended ? priorAttempts : priorAttempts + 1;
    const wait = contended ? (retryAfter ?? backoffMs(1)) : Math.max(backoffMs(attempts), retryAfter ?? 0);
    db.update(templateUses)
      .set({ reportAttempts: attempts, reportNextAt: new Date(at + wait) })
      .where(or(mine, rest))
      .run();
    failed += claimed.length;
    logger.debug(
      { tag: TAG, op: "use_report_failed", cloudId, source: catalogSource(), uses: claimed.length, attempts, waitMs: wait, status: r.status, code: r.code, error: r.error },
      "use notice failed; backing off",
    );
  }
  return { sent, failed, skipped };
}

/**
 * Drain on the next turn and every DRAIN_INTERVAL_MS, one pass at a time.
 * Idempotent; the timers never hold the process open. The first pass is
 * deferred rather than run inline because this is called from `register()`,
 * which Next awaits before serving: the pass's synchronous SQL would delay the
 * first request.
 */
export function startUseReporter(deps: Deps = {}): void {
  if (timer) return;
  const tick = () => {
    if (inFlight) return;
    const pass: Promise<void> = drainUseReports(deps)
      .then(() => {
        drainFailing = false;
      })
      .catch((err: unknown) => {
        const fields = { tag: TAG, op: "use_drain_failed", err };
        if (drainFailing) logger.debug(fields, "use reporter drain failed again");
        else logger.warn(fields, "use reporter drain failed; repeats log at debug until a pass succeeds");
        drainFailing = true;
      })
      .finally(() => {
        if (inFlight === pass) inFlight = null;
      });
    inFlight = pass;
  };
  timer = setInterval(tick, DRAIN_INTERVAL_MS);
  timer.unref?.();
  firstPass = setTimeout(() => {
    firstPass = null;
    tick();
  }, 0);
  firstPass.unref?.();
}

export function stopUseReporter(): void {
  if (timer) clearInterval(timer);
  if (firstPass) clearTimeout(firstPass);
  timer = null;
  firstPass = null;
}

export function __resetUseReporterForTests(): void {
  stopUseReporter();
  inFlight = null;
  drainFailing = false;
}
