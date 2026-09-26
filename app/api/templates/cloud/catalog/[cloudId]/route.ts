import { NextResponse } from "next/server";
import { serverLogger as logger } from "@/lib/logger";
import { crossSiteSubresourceRefusal } from "@/lib/security/request-guard";
import { catalogRateLimitedFor, catalogScaffold, forgetCatalogTemplate, noteCatalogListed, noteCatalogRateLimited } from "@/lib/templates/cloud/catalog-detail";
import { catalogSource, withCatalogSource } from "@/lib/templates/cloud/catalog-source";
import { getCloudTemplate, isNoSuchTemplate } from "@/lib/templates/cloud/client";
import { CLOUD_ID_PATTERN } from "@/lib/templates/cloud/constants";
import { findInstalledTemplate } from "@/lib/templates/store";

export const dynamic = "force-dynamic";

const TAG = "templates-cloud";
const GONE = "This template is no longer in the catalog.";
/** When the site's 429 names no Retry-After: its window is a minute. */
const DEFAULT_RETRY_AFTER_MS = 60_000;

type Ctx = { params: Promise<{ cloudId: string }> };

/** 429 `rate_limited`, with when to ask again. */
function rateLimited(retryAfterSec: number): Response {
  return NextResponse.json(
    { error: "The catalog asked libi to slow down. Try again in a minute.", code: "rate_limited", retryAfterSec },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

/**
 * GET /api/templates/cloud/catalog/<cloudId> — a public template's page data,
 * WITHOUT installing it: `{ template, scaffold, mediaBase, installedTemplateId }`.
 *  - `template`: the catalog's document (`getCloudTemplate`, validated as an
 *    install validates it — its current name, description and tags, uses,
 *    and `uses30d` / `lastUsedDay` when the site sends them);
 *  - `scaffold`: its `template.json` alone, fetched and checked through the
 *    install's own path (`fetchCatalogScaffold`) and kept in memory per
 *    version (`lib/templates/cloud/catalog-detail.ts`);
 *  - `mediaBase`: the template's folder in the bucket (base + prefix), which
 *    its file assets resolve against;
 *  - `installedTemplateId`: the local row this machine already has for it.
 *
 * `droppedAssets`: how many of its assets the install's own check refused —
 * left out of `scaffold`, never shown or streamed. `installedOrigin`: whether
 * the local row is an installed copy or the user's own published template.
 *
 * Refusals are fixed codes and libi's own words, never the site's: 400
 * `invalid` (not a catalog id), 404 `not_found` (removed or hidden), 429
 * `rate_limited` with `Retry-After` (the site's limit, passed through — and,
 * until it passes, answered for EVERY template without asking the site: the
 * limit is per client), 502
 * `unreachable` (no answer) / `unavailable` (the site answered with an error)
 * / `invalid_template` (its template.json was refused).
 *
 * A read with an outside effect (it calls the site), so another page's
 * subresource request or navigation is refused before anything is fetched:
 * 403 `cross_site_read` (lib/security/request-guard.ts#crossSiteSubresourceRefusal).
 */
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const refused = crossSiteSubresourceRefusal(req);
  if (refused) {
    logger.warn({ tag: TAG, op: "catalog_detail_refused", reason: refused }, "refused a cross-site request for a public template's page");
    return NextResponse.json({ error: "A public template's page is shown only on libi's own page.", code: "cross_site_read" }, { status: 403 });
  }
  // One catalog for the whole answer — its backoff, document, scaffold and listing — whatever the user switches to meanwhile.
  return withCatalogSource(catalogSource(), () => answer(ctx));
}

async function answer(ctx: Ctx): Promise<Response> {
  const { cloudId } = await ctx.params;
  if (!CLOUD_ID_PATTERN.test(cloudId)) return NextResponse.json({ error: "Not a catalog template id.", code: "invalid" }, { status: 400 });

  // Still inside the site's Retry-After from an earlier 429 — for ANY template: don't ask it again yet.
  const waitMs = catalogRateLimitedFor();
  if (waitMs > 0) return rateLimited(Math.ceil(waitMs / 1000));

  const fetched = await getCloudTemplate(cloudId);
  if (!fetched.ok) {
    if (isNoSuchTemplate(fetched)) {
      // Taken down or hidden: none of its media may stream any more (fix-round review N4).
      forgetCatalogTemplate(cloudId);
      return NextResponse.json({ error: GONE, code: "not_found" }, { status: 404 });
    }
    // The site's per-client limit (10 public GETs a minute, shared with installs): passed through as
    // itself, with when to ask again, so the page backs off instead of retrying into it (review I2).
    if (fetched.status === 429) {
      // Capped (confirmation review C2): an absurd Retry-After must not lock every page until a restart.
      const retryAfterSec = noteCatalogRateLimited(fetched.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS);
      logger.info({ tag: TAG, op: "catalog_detail_rate_limited", cloudId, retryAfterSec }, "the catalog asked libi to slow down");
      return rateLimited(retryAfterSec);
    }
    const code = fetched.status === undefined ? "unreachable" : "unavailable";
    logger.warn({ tag: TAG, op: "catalog_detail_failed", cloudId, code, status: fetched.status ?? null, error: fetched.error }, "couldn't read a public template for its page");
    return NextResponse.json(
      {
        error: code === "unreachable" ? "Couldn't reach the catalog. Check your connection and try again." : "The catalog couldn't answer right now. Try again later.",
        code,
      },
      { status: 502 },
    );
  }
  const t = fetched.template;
  noteCatalogListed(cloudId, t.version);

  let read;
  try {
    read = await catalogScaffold(t);
  } catch (err) {
    // The install's refusal carries a code: `download_failed` is the network, anything else the content.
    const unreachable = (err as { code?: unknown })?.code === "download_failed";
    logger.warn(
      { tag: TAG, op: "catalog_detail_scaffold_refused", cloudId, version: t.version, error: err instanceof Error ? err.message : String(err) },
      "a public template's template.json was not shown",
    );
    return NextResponse.json(
      unreachable
        ? { error: "Couldn't download this template's details. Try again.", code: "unreachable" }
        : { error: "This template's details can't be shown: its files don't match the catalog.", code: "invalid_template" },
      { status: 502 },
    );
  }

  const local = findInstalledTemplate(cloudId);
  return NextResponse.json({
    template: t,
    scaffold: read.scaffold,
    droppedAssets: read.droppedAssets,
    mediaBase: t.base + t.prefix,
    installedTemplateId: local?.id ?? null,
    installedOrigin: local?.origin ?? null,
  });
}
