/**
 * The public catalog's index, cached in `catalog_index` and mirrored into
 * `templates_fts` under scope "public", so one search serves local and public
 * rows. Refreshed when the Templates page asks (every 10 minutes while it is
 * open, every minute while one of this install's own publishes, hides or
 * shows isn't in the copy yet — `noteOwnCatalogChange`) and, behind the
 * answer, when `libi.template` list / search read a stale copy —
 * only a read with no copy at all waits on the network.
 *
 * Best effort throughout: offline is a normal state. A failed refresh keeps
 * the last good copy and says why (a fixed code, never the site's words),
 * and further non-forced refreshes back off (2 minutes, doubling to 15);
 * nothing here throws into a caller.
 *
 * The rows are validated by the cloud client (lib/templates/cloud/client.ts)
 * but still a STRANGER's words — whatever hands them to an agent labels them.
 * Media paths are stored relative to the bucket base and resolved on read,
 * so a copy cached under one environment never points into another. The copy
 * also records which catalog it came from (`catalogSource` — the catalog, not
 * the port: the fixture's media resolve under whatever port this boot has),
 * and a copy from another is never served — not its rows, its search hits,
 * its etag nor its freshness. Without that, a test-mode run's fixture cards stayed in the
 * next normal boot on the same LIBI_HOME, their media pointing nowhere.
 *
 * A dev build switches between the production and a development catalog
 * (lib/templates/cloud/catalog-setting.ts), so everything here is keyed by
 * the catalog: the ONE cached copy is served only to the catalog it came from
 * (a switch refetches, and switching back refetches again), and the refresh
 * in flight, the failure backoff and this install's own changes are kept per
 * catalog. A refresh pins the catalog it started with: switching while it is
 * on the wire neither sends it elsewhere nor files its answer under the new one.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { catalogIndex, catalogIndexMeta } from "@/lib/db/schema/sqlite";
import { serverLogger as logger } from "@/lib/logger";
import { fetchIndex, type CatalogIndex, type IndexFailReason } from "@/lib/templates/cloud/client";
import { activeCatalogSource } from "@/lib/templates/cloud/catalog-setting";
import { TEST_MODE_SOURCE, catalogBucketBaseFor, catalogSource, withCatalogSource } from "@/lib/templates/cloud/catalog-source";
import { deleteFtsScope, insertFtsRows } from "@/lib/templates/search";
import type { TemplateOrder, TemplateSummary } from "@/lib/templates/types";

const TAG = "templates";
export const CATALOG_STALE_MS = 10 * 60 * 1000;
/** A list with no query shows at most this many public entries. */
const DEFAULT_LIMIT = 500;

export type CatalogRow = typeof catalogIndex.$inferSelect;

/**
 * Why the last refresh failed — the only failure text that leaves this module
 * (to the agent via `catalogStatus`, to the Templates page via the catalog
 * route). The client's message can carry the site's own words, so it goes to
 * the log and nowhere else. `internal` is a local failure (the cache's DB).
 */
export type CatalogErrorCode = IndexFailReason | "internal";
export const CATALOG_ERROR_CODES = ["unreachable", "http_error", "invalid_index", "internal"] as const satisfies readonly CatalogErrorCode[];

export interface CatalogRefreshResult {
  refreshed: boolean;
  entries: number;
  error?: CatalogErrorCode;
}

/** This environment's bucket base (the studio's fixture route in test mode). */
export function catalogMediaBase(): string {
  return catalogBucketBaseFor();
}

/** The cached copy's metadata — null when there is none, or it came from another catalog. */
function meta(): { etag: string | null; fetchedAt: Date | null } | null {
  const row = getDb().select().from(catalogIndexMeta).where(eq(catalogIndexMeta.id, 1)).get();
  return row && row.source === catalogSource() ? row : null;
}

/** Whether the cached rows are this catalog's. Every read of the rows asks first. */
function ownCopy(): boolean {
  return meta() !== null;
}

/** When the cached copy was last confirmed current (a 200 or a 304), in ms; null before the first. */
export function catalogFetchedAt(): number | null {
  return meta()?.fetchedAt?.getTime() ?? null;
}

/**
 * Stale past 10 minutes — or sooner while one of this install's own changes
 * (`noteOwnCatalogChange`) isn't in the copy yet: at once when the copy was
 * fetched before the change, then once a minute (OWN_CHANGE_RECHECK_MS).
 * Only ever a non-forced refresh, so the failure backoff (a 429 included)
 * still holds it back.
 */
export function isCatalogStale(now: number = Date.now()): boolean {
  const at = catalogFetchedAt();
  if (at === null || now - at > CATALOG_STALE_MS) return true;
  const pending = pendingOwnCatalogChanges(now);
  if (pending.length === 0) return false;
  return pending.some((c) => at < c.at) || now - at > OWN_CHANGE_RECHECK_MS;
}

// ---------------------------------------------------------------------------
// This install's own changes to the catalog
// ---------------------------------------------------------------------------

/**
 * What this install just did to the catalog: published a template (a new
 * version included), showed one again, or hid one. The Templates page's
 * Public tab reads the cached copy, which predated the change — so right
 * after the user's own publish it said "No public templates yet" until
 * Refresh or the 10-minute window (2026-09-26 live check, N1).
 *
 * A forced refresh on the site needs its secret, and in production the
 * index route's answer is edge-cached for five minutes (libi-site
 * INDEX_ROUTE_CACHE_CONTROL, `s-maxage=300`), so even a fetch straight after
 * the commit can bring back the old index. So the change is remembered here
 * until the copy shows it: the copy counts as stale at once, then is
 * re-checked once a minute (a conditional GET — a 304 while the edge still
 * holds the old one), within the site's per-IP 10/minute and never past the
 * failure backoff. The catalog route hands the pending changes to the page,
 * which shows the author's own template from `/mine` meanwhile, with a note
 * that the catalog may take a few minutes.
 *
 * Given up after OWN_CHANGE_WATCH_MS: a commit that answered `indexed: false`
 * is listed only by the site's hourly refresh, and the ordinary 10-minute
 * refresh covers that.
 *
 * On globalThis, per process: the publish job and the visibility route note
 * a change and the catalog route reads it, all in the studio process, but a
 * Next dev server may load this module more than once. The MCP child keeps
 * none — its reads see the studio's refreshed copy in the shared database.
 */
export type OwnCatalogChangeKind = "published" | "shown" | "hidden";
export interface OwnCatalogChange {
  cloudId: string;
  /** The version the change is about: listed at it or later (`published`, `shown`), or gone (`hidden`). */
  version: number;
  kind: OwnCatalogChangeKind;
  /** When libi noted it, in ms. */
  at: number;
}

/** How long an own change is watched for before the ordinary refresh takes over. */
export const OWN_CHANGE_WATCH_MS = 15 * 60 * 1000;
/** While one is pending, how often the copy is re-checked (the site allows 10 index reads a minute per IP). */
export const OWN_CHANGE_RECHECK_MS = 60 * 1000;

declare global {
  /** Per catalog source, then per cloud id. */
  var __libiOwnCatalogChangesBySource: Map<string, Map<string, OwnCatalogChange>> | undefined;
}

/** This catalog's own changes (catalog ids differ between catalogs, so each keeps its own). */
function ownChanges(source: string = catalogSource()): Map<string, OwnCatalogChange> {
  const all = (globalThis.__libiOwnCatalogChangesBySource ??= new Map());
  let map = all.get(source);
  if (!map) all.set(source, (map = new Map()));
  return map;
}

/**
 * Remember one of this install's own catalog changes until the cached copy
 * shows it (see above). A later change to the same template replaces the
 * earlier one. Never throws.
 */
export function noteOwnCatalogChange(change: Omit<OwnCatalogChange, "at">, now: number = Date.now()): void {
  const source = catalogSource();
  ownChanges(source).set(change.cloudId, { ...change, at: now });
  logger.info({ tag: TAG, op: "catalog_own_change_noted", cloudId: change.cloudId, version: change.version, kind: change.kind, source }, "own catalog change noted; the copy is re-checked until it shows it");
}

/** Whether the cached copy already shows `c`. */
function reflected(c: OwnCatalogChange): boolean {
  const row = getCatalogEntry(c.cloudId);
  return c.kind === "hidden" ? row === null : row !== null && row.version >= c.version;
}

/** The own changes the cached copy doesn't show yet; the shown and the expired are forgotten here. */
export function pendingOwnCatalogChanges(now: number = Date.now()): OwnCatalogChange[] {
  const map = ownChanges();
  for (const [id, c] of map) {
    if (now - c.at > OWN_CHANGE_WATCH_MS || reflected(c)) map.delete(id);
  }
  return [...map.values()];
}

/** Rows per multi-row INSERT: ~20 columns each keeps a chunk far under SQLite's 32,766-variable ceiling. */
const REPLACE_CHUNK = 500;

/**
 * Replace the whole cache and its FTS mirror in one transaction — a failure
 * part-way keeps the old copy. The scope is cleared first, so rows go in by
 * plain chunked INSERTs: a 20k-entry index replaces in well under a second
 * (it holds the write lock the other process waits on for up to 5 s).
 */
export function replaceCatalog(index: CatalogIndex, etag: string | null, now: number, source: string = catalogSource()): void {
  getDb().transaction((tx) => {
    tx.delete(catalogIndex).run();
    deleteFtsScope(tx, "public");
    const fetchedAt = new Date(now);
    for (let i = 0; i < index.entries.length; i += REPLACE_CHUNK) {
      const chunk = index.entries.slice(i, i + REPLACE_CHUNK);
      tx.insert(catalogIndex)
        .values(
          chunk.map((e) => ({
            cloudId: e.id,
            name: e.name,
            description: e.description,
            tagsJson: JSON.stringify(e.tags),
            nickname: e.nickname,
            authorId: e.authorId,
            version: e.version,
            hasCode: e.hasCode,
            canvasWidth: e.canvas.width,
            canvasHeight: e.canvas.height,
            duration: e.duration,
            slotCount: e.slotCount,
            poster: e.poster,
            video: e.video,
            usesTotal: e.usesTotal,
            uses7d: e.uses7d,
            heat: e.heat,
            createdAt: new Date(e.createdAt),
            updatedAt: new Date(e.updatedAt),
            fetchedAt,
          })),
        )
        .run();
      insertFtsRows(
        tx,
        chunk.map((e) => ({ scope: "public" as const, refId: e.id, name: e.name, description: e.description, tags: e.tags })),
      );
    }
    const set = { etag, fetchedAt, source };
    tx.insert(catalogIndexMeta).values({ id: 1, ...set }).onConflictDoUpdate({ target: catalogIndexMeta.id, set }).run();
  });
}

/**
 * `replaceCatalog`, unless the answer is from a catalog that is no longer the
 * active one AND the slot already holds the active catalog's copy (review M1):
 * a slow refresh of the catalog the user switched away from must not evict
 * the copy the Public tab and the agent now read. Checked inside the write's
 * own transaction. Into an empty slot, or over a third catalog's copy, it
 * still writes — the copy is tagged with its catalog and served only to it.
 * Returns whether it wrote.
 */
export function replaceCatalogUnlessSuperseded(index: CatalogIndex, etag: string | null, now: number, source: string): boolean {
  // IMMEDIATE: the check and the write hold the write lock together, so the
  // other process (the MCP child) can't land the active copy in between.
  return getDb().transaction(
    (tx) => {
      // Fresh, not the ≤ 1 s memo (review m1): a switch the other process made a moment ago counts.
      const active = activeCatalogSource({ fresh: true });
      if (source !== active) {
        const held = tx.select({ source: catalogIndexMeta.source }).from(catalogIndexMeta).where(eq(catalogIndexMeta.id, 1)).get()?.source ?? null;
        if (held === active) return false;
      }
      replaceCatalog(index, etag, now, source);
      return true;
    },
    { behavior: "immediate" },
  );
}

export function listCatalogEntries(): CatalogRow[] {
  if (!ownCopy()) return [];
  return getDb().select().from(catalogIndex).all();
}

function catalogCount(): number {
  if (!ownCopy()) return 0;
  return getDb().select({ n: sql<number>`count(*)` }).from(catalogIndex).get()?.n ?? 0;
}

export function getCatalogEntry(cloudId: string): CatalogRow | null {
  if (!ownCopy()) return null;
  return getDb().select().from(catalogIndex).where(eq(catalogIndex.cloudId, cloudId)).get() ?? null;
}

function toSummary(row: CatalogRow, base: string): TemplateSummary {
  return {
    id: null,
    cloudId: row.cloudId,
    name: row.name,
    description: row.description,
    tags: JSON.parse(row.tagsJson) as string[],
    origin: "public",
    version: row.version,
    hasCode: row.hasCode,
    slots: [],
    slotCount: row.slotCount,
    canvas: { width: row.canvasWidth, height: row.canvasHeight, fps: null },
    duration: row.duration,
    usesTotal: row.usesTotal,
    uses7d: row.uses7d,
    lastUsedAt: null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    hasPoster: true,
    hasExample: true,
    poster: base + row.poster,
    video: base + row.video,
    nickname: row.nickname,
    broken: null,
    otherCatalog: null,
    mediaRev: 0,
    canRenderExample: false,
    sourcePieceName: null,
    sourceEmpty: false,
  };
}

/**
 * The one ordering for summaries, local and public alike: trending = uses in
 * the last 7 days, then all-time uses, then most recently updated; most-used
 * = all-time uses, then most recently updated; newest = created. `rank`
 * (an FTS hit list's position) breaks what the order leaves tied.
 */
export function compareSummaries(order: TemplateOrder, rank?: Map<string, number>) {
  const time = (iso: string) => Date.parse(iso);
  const key = (s: TemplateSummary) => s.id ?? s.cloudId ?? "";
  const tie = (a: TemplateSummary, b: TemplateSummary) => (rank ? (rank.get(key(a)) ?? 0) - (rank.get(key(b)) ?? 0) : 0);
  const byUpdated = (a: TemplateSummary, b: TemplateSummary) => time(b.updatedAt) - time(a.updatedAt);
  return (a: TemplateSummary, b: TemplateSummary): number => {
    if (order === "newest") return time(b.createdAt) - time(a.createdAt) || tie(a, b);
    if (order === "most-used") return b.usesTotal - a.usesTotal || byUpdated(a, b) || tie(a, b);
    return b.uses7d - a.uses7d || b.usesTotal - a.usesTotal || byUpdated(a, b) || tie(a, b);
  };
}

/**
 * Cached public entries as summaries (`id` null, `cloudId` set, media absolute
 * under this environment's bucket base). `ids` (an FTS hit list, best first)
 * narrows to those entries and breaks ties in the chosen order.
 */
export function catalogSummaries(opts: { ids?: string[]; order: TemplateOrder; limit?: number }): TemplateSummary[] {
  if (!ownCopy()) return [];
  const db = getDb();
  let rows: CatalogRow[];
  if (opts.ids) {
    if (opts.ids.length === 0) return [];
    rows = db.select().from(catalogIndex).where(inArray(catalogIndex.cloudId, opts.ids)).all();
  } else {
    // The SQL order picks WHICH rows survive the limit; the sort below is the one that counts.
    const col = opts.order === "trending" ? catalogIndex.uses7d : opts.order === "most-used" ? catalogIndex.usesTotal : catalogIndex.createdAt;
    rows = db.select().from(catalogIndex).orderBy(desc(col), desc(catalogIndex.usesTotal), desc(catalogIndex.updatedAt)).limit(opts.limit ?? DEFAULT_LIMIT).all();
  }
  const base = catalogMediaBase();
  const rank = opts.ids ? new Map(opts.ids.map((id, i) => [id, i])) : undefined;
  return rows.map((r) => toSummary(r, base)).sort(compareSummaries(opts.order, rank));
}

/** After a failed refresh, non-forced refreshes wait this long, doubling per further failure up to the max. */
export const CATALOG_BACKOFF_MIN_MS = 2 * 60 * 1000;
export const CATALOG_BACKOFF_MAX_MS = 15 * 60 * 1000;

/**
 * Bumped by the test reset. A fetch started under an older generation was
 * abandoned: whatever it answers is dropped — no write, no backoff change.
 */
let generation = 0;

/**
 * Per process (the studio and the MCP child each keep their own) and per
 * catalog: one fetch in flight, and the failure backoff. A blackholed network
 * costs a fetch its full 10 s timeout, so without the backoff every public
 * read while offline paid it again; per catalog, so a development site that
 * is down never holds back the production one after a switch (or the reverse).
 */
interface RefreshState {
  inflight: Promise<CatalogRefreshResult> | null;
  failures: number;
  retryAt: number;
  lastError: CatalogErrorCode | undefined;
}
const refreshStates = new Map<string, RefreshState>();

function refreshState(source: string = catalogSource()): RefreshState {
  let st = refreshStates.get(source);
  if (!st) refreshStates.set(source, (st = { inflight: null, failures: 0, retryAt: 0, lastError: undefined }));
  return st;
}

function recordFailure(st: RefreshState, error: CatalogErrorCode): void {
  st.failures += 1;
  st.lastError = error;
  st.retryAt = Date.now() + Math.min(CATALOG_BACKOFF_MIN_MS * 2 ** (st.failures - 1), CATALOG_BACKOFF_MAX_MS);
}

function recordSuccess(st: RefreshState): void {
  st.failures = 0;
  st.retryAt = 0;
  st.lastError = undefined;
}

/** What a caller can say about the public set it was served: when it was last confirmed, and why the last refresh failed (a fixed code). */
export function catalogStatus(): { fetchedAt: string | null; error?: CatalogErrorCode } {
  const at = catalogFetchedAt();
  const { lastError } = refreshState();
  return { fetchedAt: at === null ? null : new Date(at).toISOString(), ...(lastError ? { error: lastError } : {}) };
}

/**
 * Forget the in-flight fetch and the backoff — module state that would
 * otherwise leak between tests. A fetch still pending is abandoned: when it
 * answers, it writes nothing into the next test's database.
 */
export function resetCatalogRefreshForTests(): void {
  generation += 1;
  refreshStates.clear();
  globalThis.__libiOwnCatalogChangesBySource?.clear();
}

/**
 * Test mode's "libi has never fetched the catalog": the module state resets
 * as between unit tests, and a copy of the FIXTURE catalog — its cached rows,
 * their FTS mirror and the metadata row — goes. Reached only through
 * app/api/test-mode/catalog-cache, which refuses outside test mode — an e2e
 * spec can't otherwise establish a first open once an earlier spec has opened
 * the Templates page.
 *
 * Only a copy recorded as test mode's. Test mode shares LIBI_HOME with a
 * normal boot, so the cache may hold the REAL site's copy, which test mode
 * already reads as none (`meta()`): that one stays for the next normal boot,
 * as do local templates and their FTS rows (scope `local`).
 */
export function forgetCatalogCopy(): void {
  getDb().transaction((tx) => {
    const row = tx.select({ source: catalogIndexMeta.source }).from(catalogIndexMeta).where(eq(catalogIndexMeta.id, 1)).get();
    if (row?.source !== TEST_MODE_SOURCE) return;
    tx.delete(catalogIndex).run();
    deleteFtsScope(tx, "public");
    tx.delete(catalogIndexMeta).run();
  });
  resetCatalogRefreshForTests();
}

async function runRefresh(gen: number, source: string, st: RefreshState): Promise<CatalogRefreshResult> {
  try {
    const r = await fetchIndex({ etag: meta()?.etag ?? null });
    if (gen !== generation) return { refreshed: false, entries: 0 };
    if (!r.ok) {
      recordFailure(st, r.reason);
      logger.debug({ tag: TAG, op: "catalog_refresh_failed", reason: r.reason, error: r.error, failures: st.failures, source }, "public catalog refresh failed, cache kept");
      return { refreshed: false, entries: catalogCount(), error: r.reason };
    }
    if (r.notModified) {
      // Only the copy this conditional GET was about: never another catalog's.
      getDb().update(catalogIndexMeta).set({ fetchedAt: new Date() }).where(and(eq(catalogIndexMeta.id, 1), eq(catalogIndexMeta.source, source))).run();
      recordSuccess(st);
      return { refreshed: false, entries: catalogCount() };
    }
    if (!replaceCatalogUnlessSuperseded(r.index, r.etag, Date.now(), source)) {
      // A late answer from the catalog the user switched away from, while the
      // slot already holds the active one's copy: dropped, never evicting it.
      recordSuccess(st);
      logger.debug({ tag: TAG, op: "catalog_refresh_superseded", source, entries: r.index.entries.length }, "a refresh answered for a catalog no longer active; the active catalog's copy is kept");
      return { refreshed: false, entries: 0 };
    }
    recordSuccess(st);
    logger.info({ tag: TAG, op: "catalog_refreshed", entries: r.index.entries.length, source }, "public catalog refreshed");
    return { refreshed: true, entries: r.index.entries.length };
  } catch (err) {
    if (gen !== generation) return { refreshed: false, entries: 0 };
    const error = err instanceof Error ? err.message : String(err);
    recordFailure(st, "internal");
    logger.warn({ tag: TAG, op: "catalog_refresh_failed", reason: "internal", error, failures: st.failures, source }, "public catalog refresh failed, cache kept");
    try {
      return { refreshed: false, entries: catalogCount(), error: "internal" };
    } catch {
      return { refreshed: false, entries: 0, error: "internal" };
    }
  }
}

/**
 * Best effort: one fetch at a time (callers share it), nothing thrown, the
 * cache kept on any failure. After a failure a non-forced call skips the
 * network for the backoff window and answers from the cache (or the empty
 * set) with the last error; `force` (a user asking) always tries.
 */
export function refreshCatalogIfStale(opts: { force?: boolean } = {}): Promise<CatalogRefreshResult> {
  const source = catalogSource();
  const st = refreshState(source);
  if (st.inflight) return st.inflight;
  if (!opts.force && !isCatalogStale()) return Promise.resolve({ refreshed: false, entries: catalogCount() });
  if (!opts.force && Date.now() < st.retryAt) {
    return Promise.resolve({ refreshed: false, entries: catalogCount(), ...(st.lastError ? { error: st.lastError } : {}) });
  }
  // The guard is cleared by `.finally`, which always runs after this
  // assignment. A `finally` inside runRefresh ran BEFORE it whenever the run
  // failed ahead of its first await (a DB error reading the etag), so the
  // settled promise was stored afterwards and served to every later call.
  // Pinned to `source` throughout: the fetch, the etag it sends and the copy it writes.
  const run: Promise<CatalogRefreshResult> = withCatalogSource(source, () => runRefresh(generation, source, st)).finally(() => {
    if (st.inflight === run) st.inflight = null;
  });
  st.inflight = run;
  return run;
}

/**
 * For agent-facing reads: with a cached copy, never wait on the network —
 * serve the cache and refresh behind it. With none yet, wait for the first
 * fetch (the backoff keeps a repeat from waiting again).
 */
export async function ensureCatalogForRead(): Promise<void> {
  if (catalogFetchedAt() === null) {
    await refreshCatalogIfStale();
    return;
  }
  void refreshCatalogIfStale();
}
