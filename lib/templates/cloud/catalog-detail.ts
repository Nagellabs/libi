/**
 * A public template's scaffold for its page in libi, kept in memory per
 * `cloudId@version`: a published version's `template.json` never changes (a
 * new version is a new folder), so a version read once is served again
 * without a download. At most 50 versions, the oldest read dropped first.
 * A refusal is not cached — the next view asks again. Concurrent views of a
 * version share ONE download (single-flight, D5–D6 review M7).
 *
 * The cache is also what the page's media stream answers from
 * (`confirmStreamableAsset`): only a link-only audio or video asset of the
 * CURRENT listed version of a public template this process has shown — and
 * so checked — is streamed, and only while the catalog confirmed it listed
 * within STREAMABLE_FOR_MS; past that it is re-asked on demand (one request
 * per template, however many Range requests arrive at once). A `not_found`
 * forgets the template at once.
 *
 * Every piece of it — the scaffolds, the listing confirmations, the
 * re-confirmations in flight and both 429 backoffs — is kept per CATALOG
 * (`catalogSource()`): catalog ids differ between the production and a dev
 * build's development catalog, and each site's rate limit is its own. A
 * re-confirmation pins the catalog it was asked for.
 */
import { catalogSource, withCatalogSource } from "@/lib/templates/cloud/catalog-source";
import { getCloudTemplate, isNoSuchTemplate, type CloudTemplate } from "@/lib/templates/cloud/client";
import { CATALOG_RETRY_AFTER_CAP_SEC } from "@/lib/templates/cloud/constants";
import { fetchCatalogScaffold, type CatalogScaffold } from "@/lib/templates/cloud/install";

export { CATALOG_RETRY_AFTER_CAP_SEC };

const MAX_ENTRIES = 50;

/** The outcome of re-asking the catalog whether a template is listed. */
type Reconfirm = { ok: true } | { ok: false; code: "not_found" | "unavailable" } | { ok: false; code: "rate_limited"; retryAfterSec: number };

interface Shared {
  cache: Map<string, CatalogScaffold>;
  inflight: Map<string, Promise<CatalogScaffold>>;
  /** When the catalog last said each template is listed (its public GET answered it)… */
  listedAt: Map<string, number>;
  /** …and at which version: only that version's assets stream (final review F4). */
  listedVersion: Map<string, number>;
  /** A re-confirmation in flight per template (final review F2). */
  reconfirming: Map<string, Promise<Reconfirm>>;
  /** The PAGE route's backoff after the catalog's 429 (N5). */
  rateLimitedUntil: number;
  /** The STREAM route's own backoff after a 429 on its listing re-check (see `noteStreamRateLimited`). */
  streamRateLimitedUntil: number;
}

// On globalThis, as JobManager is: each Next route bundle has its own copy of
// this module, and the page route (which fills the cache) and the stream route
// (which reads it) must share one. One `Shared` per catalog source.
declare global {
  var __libiCatalogScaffoldsBySource: Map<string, Shared> | undefined;
}

function state(source: string = catalogSource()): Shared {
  const all = (globalThis.__libiCatalogScaffoldsBySource ??= new Map());
  let st = all.get(source);
  if (!st) {
    st = { cache: new Map(), inflight: new Map(), listedAt: new Map(), listedVersion: new Map(), reconfirming: new Map(), rateLimitedUntil: 0, streamRateLimitedUntil: 0 };
    all.set(source, st);
  }
  return st;
}

/**
 * How long after the catalog last confirmed a template is listed its media
 * may still be streamed without asking again. Past it, the stream route asks
 * on demand (`confirmStreamableAsset`); a template taken down meanwhile is
 * refused.
 */
export const STREAMABLE_FOR_MS = 15 * 60_000;

export async function catalogScaffold(t: CloudTemplate): Promise<CatalogScaffold> {
  const { cache, inflight } = state();
  const key = `${t.id}@${t.version}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const p = fetchCatalogScaffold(t)
    .then((read) => {
      cache.set(key, read);
      while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
      return read;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** The link-only audio/video asset `url` in the CURRENT listed version's checked scaffold, or null. */
function currentStreamableAsset(cloudId: string, url: string): { kind: "audio" | "video" } | null {
  const { cache, listedVersion } = state();
  const version = listedVersion.get(cloudId);
  if (version === undefined) return null;
  const read = cache.get(`${cloudId}@${version}`);
  const a = read?.scaffold.assets.find((x) => x.url === url && (x.kind === "audio" || x.kind === "video"));
  return a ? { kind: a.kind as "audio" | "video" } : null;
}

/**
 * The link-only audio or video asset `url` of public template `cloudId`, as
 * its current listed version's (checked) scaffold lists it, while the listing
 * is fresh — or null. Synchronous; the stream route uses `confirmStreamableAsset`.
 */
export function catalogStreamableAsset(cloudId: string, url: string, now: number = Date.now()): { kind: "audio" | "video" } | null {
  const confirmed = state().listedAt.get(cloudId);
  if (confirmed === undefined || now - confirmed > STREAMABLE_FOR_MS) return null;
  return currentStreamableAsset(cloudId, url);
}

/** Seconds kept for a Retry-After, capped at CATALOG_RETRY_AFTER_CAP_SEC; 60 s when the site named none. */
function cappedRetryAfterSec(retryAfterMs: number | undefined): number {
  return Math.min(CATALOG_RETRY_AFTER_CAP_SEC, Math.max(1, Math.ceil((retryAfterMs ?? 60_000) / 1000)));
}

/**
 * The PAGE backoff. The site's public-GET limit is per CLIENT (libi's
 * address), not per template: after a 429 on a page read, no template's page
 * asks again until its Retry-After has passed (N5). Process-wide, so every
 * page, tab and window shares it.
 */
export function catalogRateLimitedFor(now: number = Date.now()): number {
  return Math.max(0, state().rateLimitedUntil - now);
}

/** Remember a page read's 429 (Retry-After capped; C2); returns the seconds kept. */
export function noteCatalogRateLimited(retryAfterMs: number | undefined, now: number = Date.now()): number {
  const sec = cappedRetryAfterSec(retryAfterMs);
  const st = state();
  st.rateLimitedUntil = Math.max(st.rateLimitedUntil, now + sec * 1000);
  return sec;
}

/**
 * The STREAM backoff, and why it is scoped apart (final review): the stream
 * route's listing re-check and a page read spend the same per-client budget
 * at the site, so the stream gate honours the page backoff (asking while a
 * page read was just refused would only be refused too). But a 429 on a
 * re-check, which a seek late in a long clip can trigger, arms only THIS
 * backoff: it holds back further re-checks for the site's Retry-After
 * (capped), while page loads — the reads that tell the user what is going
 * on, each of which arms the page backoff itself if the site still refuses
 * it — are not blocked on its account.
 */
export function streamRateLimitedFor(now: number = Date.now()): number {
  const st = state();
  return Math.max(0, Math.max(st.streamRateLimitedUntil, st.rateLimitedUntil) - now);
}

function noteStreamRateLimited(retryAfterMs: number | undefined, now: number = Date.now()): number {
  const sec = cappedRetryAfterSec(retryAfterMs);
  const st = state();
  st.streamRateLimitedUntil = Math.max(st.streamRateLimitedUntil, now + sec * 1000);
  return sec;
}

/** Whether `url` may stream for `cloudId` now — answered, when the listing has gone stale, by asking the catalog again. */
export type StreamGate =
  | { ok: true; kind: "audio" | "video" }
  | { ok: false; code: "not_an_asset" | "not_found" | "unavailable" }
  | { ok: false; code: "rate_limited"; retryAfterSec: number };

/** Ask the catalog whether `cloudId` is listed — once per template however many callers wait (F2). */
function reconfirm(cloudId: string): Promise<Reconfirm> {
  const source = catalogSource();
  const { reconfirming } = state(source);
  const running = reconfirming.get(cloudId);
  if (running) return running;
  const p = withCatalogSource(source, async (): Promise<Reconfirm> => {
    const fetched = await getCloudTemplate(cloudId);
    if (fetched.ok) {
      // The version the catalog lists now; its scaffold is read (and checked) if this process lacks it.
      try {
        await catalogScaffold(fetched.template);
      } catch {
        return { ok: false, code: "unavailable" };
      }
      noteCatalogListed(cloudId, fetched.template.version);
      return { ok: true };
    }
    if (isNoSuchTemplate(fetched)) {
      forgetCatalogTemplate(cloudId);
      return { ok: false, code: "not_found" };
    }
    if (fetched.status === 429) return { ok: false, code: "rate_limited", retryAfterSec: noteStreamRateLimited(fetched.retryAfterMs) };
    return { ok: false, code: "unavailable" };
  }).finally(() => reconfirming.delete(cloudId));
  reconfirming.set(cloudId, p);
  return p;
}

/**
 * The stream route's gate. The asset must be in the checked scaffold of the
 * version the catalog last listed (an older version's link does not stream,
 * F4). When the catalog's last word that the template is listed is older
 * than STREAMABLE_FOR_MS — a page left open, a seek late in a long clip — it
 * is asked ON DEMAND (confirmation review C1), once per template however many
 * Range requests arrive together (F2): listed streams (and is fresh again),
 * gone is forgotten and refused, and the backoffs are honoured before any
 * request. No background traffic: nothing asks while nobody plays.
 */
export async function confirmStreamableAsset(cloudId: string, url: string, now: number = Date.now()): Promise<StreamGate> {
  // One catalog from the first check to the last: a switch meanwhile answers the next request, not this one.
  return withCatalogSource(catalogSource(), () => confirmIn(cloudId, url, now));
}

async function confirmIn(cloudId: string, url: string, now: number): Promise<StreamGate> {
  const asset = currentStreamableAsset(cloudId, url);
  if (!asset) return { ok: false, code: "not_an_asset" };
  const confirmed = state().listedAt.get(cloudId);
  if (confirmed !== undefined && now - confirmed <= STREAMABLE_FOR_MS) return { ok: true, ...asset };
  const waitMs = streamRateLimitedFor(now);
  if (waitMs > 0) return { ok: false, code: "rate_limited", retryAfterSec: Math.ceil(waitMs / 1000) };
  const r = await reconfirm(cloudId);
  if (!r.ok) return r;
  // The listed version may have moved on: only its assets stream.
  const after = currentStreamableAsset(cloudId, url);
  return after ? { ok: true, ...after } : { ok: false, code: "not_an_asset" };
}

/** The catalog just answered this template's public GET: it is listed, at `version`. */
export function noteCatalogListed(cloudId: string, version: number, now: number = Date.now()): void {
  const { listedAt, listedVersion } = state();
  listedAt.set(cloudId, now);
  listedVersion.set(cloudId, version);
}

/** The catalog says there is no such template any more: forget every cached version, so none of its media streams again. */
export function forgetCatalogTemplate(cloudId: string): void {
  const { cache, listedAt, listedVersion } = state();
  listedAt.delete(cloudId);
  listedVersion.delete(cloudId);
  for (const key of [...cache.keys()]) if (key.startsWith(`${cloudId}@`)) cache.delete(key);
}

/** Tests and the screenshot harness: put a checked read in the cache as a page view would (and the catalog's say-so with it). */
export function __primeCatalogScaffoldForTests(t: Pick<CloudTemplate, "id" | "version">, read: CatalogScaffold, listed: number = Date.now()): void {
  const { cache, listedAt, listedVersion } = state();
  cache.set(`${t.id}@${t.version}`, read);
  listedAt.set(t.id, listed);
  listedVersion.set(t.id, t.version);
}

export function resetCatalogScaffoldCacheForTests(): void {
  globalThis.__libiCatalogScaffoldsBySource?.clear();
}
