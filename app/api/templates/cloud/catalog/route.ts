import { NextResponse } from "next/server";
import { serverLogger as logger } from "@/lib/logger";
import { crossSiteSubresourceRefusal } from "@/lib/security/request-guard";
import {
  catalogFetchedAt,
  catalogMediaBase,
  listCatalogEntries,
  pendingOwnCatalogChanges,
  refreshCatalogIfStale,
  type CatalogRefreshResult,
} from "@/lib/templates/cloud/catalog-cache";

export const dynamic = "force-dynamic";

function answer(r: CatalogRefreshResult): Response {
  const fetchedAt = catalogFetchedAt();
  return NextResponse.json({
    entries: listCatalogEntries().map(({ tagsJson, ...e }) => ({ ...e, tags: JSON.parse(tagsJson) as string[] })),
    fetchedAt: fetchedAt === null ? null : new Date(fetchedAt).toISOString(),
    base: catalogMediaBase(),
    refreshed: r.refreshed,
    ownChanges: pendingOwnCatalogChanges().map((c) => ({ cloudId: c.cloudId, version: c.version, kind: c.kind, at: new Date(c.at).toISOString() })),
    ...(r.error ? { error: r.error } : {}),
  });
}

/**
 * GET /api/templates/cloud/catalog — refresh the cached public index when it
 * is older than 10 minutes, then list it. Never 5xx: offline is a normal
 * state, answered with the last copy (possibly none) and the reason (a fixed
 * code). `poster`/`video` are relative to `base`. After a failed refresh this
 * respects the backoff and answers from the cache without trying.
 * `ownChanges`: this install's own publishes, hides and shows the copy
 * doesn't show yet (catalog-cache.ts#noteOwnCatalogChange) — the page shows
 * them from `/mine` meanwhile, and re-asks every minute while there are any.
 *
 * A read with an outside effect (it may call the site and rewrite the cache),
 * so a cross-site or same-site request — another page's `<img src>`, or a
 * hidden iframe or GET form navigating here — is refused before anything is fetched: 403 `cross_site_read`.
 * Its callers are the Templates page (a same-origin fetch) and header-less
 * clients (e2e's request context, curl); the MCP tools read the cache
 * in-process. See lib/security/request-guard.ts#crossSiteSubresourceRefusal.
 */
export async function GET(req: Request): Promise<Response> {
  const refused = crossSiteSubresourceRefusal(req);
  if (refused) {
    logger.warn({ tag: "templates-cloud", op: "catalog_refused", reason: refused }, "refused a cross-site request for the public catalog");
    return NextResponse.json({ error: "The public catalog is listed only on libi's own page.", code: "cross_site_read" }, { status: 403 });
  }
  return answer(await refreshCatalogIfStale());
}

/**
 * POST /api/templates/cloud/catalog — the Public tab's Refresh: the same
 * answer, but the fetch is forced, past both the 10-minute freshness and the
 * failure backoff. A user asking is worth the wait the backoff spares the
 * background reads. A POST so the proxy's origin gate covers it.
 */
export async function POST(): Promise<Response> {
  return answer(await refreshCatalogIfStale({ force: true }));
}
