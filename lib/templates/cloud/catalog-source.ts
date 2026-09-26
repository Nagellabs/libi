/**
 * Which public catalog this process reads, and what that means for local rows
 * that remember a catalog.
 *
 * `LIBI_TEST_MODE=1` points libi at the fixture (lib/templates/cloud/test-fixture.ts)
 * on the SAME `LIBI_HOME` a normal run uses. So everything that remembers a
 * catalog records which one — the cached index (`catalog_index_meta.source`),
 * a template's link (`templates.cloud_source`: its `cloud_id` and pending
 * publish) and each use (`template_uses.source`) — and a row from another
 * catalog is never acted on against this one: no republish-as-update, no
 * reinstall over it, no use notice. It stays, with a note (`otherCatalog`).
 *
 * Null is the production site: the one catalog a libi before this column ever
 * talked to (the migration backfills it the same way).
 *
 * A dev build can also switch between the production catalog and a
 * development one (lib/templates/cloud/catalog-setting.ts) — the same rules
 * apply: every row remembers its catalog, and every cache and queue is keyed
 * by it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getCurrentPort } from "@/lib/libi-home";
import { PRODUCTION_SITE_URL } from "@/lib/site-url";
import { catalogHost } from "@/lib/templates/cloud/catalog-origin";
import { activeCatalogSource } from "@/lib/templates/cloud/catalog-setting";
import { TEST_MODE_SOURCE, catalogBucketBase } from "@/lib/templates/cloud/constants";

export { TEST_MODE_SOURCE };

/**
 * A catalog pinned for one piece of work: everything `catalogSource()` answers
 * inside `withCatalogSource(source, fn)` — the client's API and bucket bases,
 * every cache key, every row it records — is `source`, whatever the user
 * switches to meanwhile (lib/templates/cloud/catalog-setting.ts). A publish
 * job, an install, a cache refresh and a use-report pass each pin the catalog
 * they started with. On globalThis: Next can load this module more than once.
 */
declare global {
  var __libiCatalogSourceScope: AsyncLocalStorage<string> | undefined;
}
const scope = (globalThis.__libiCatalogSourceScope ??= new AsyncLocalStorage<string>());

/** Run `fn` with `source` as the catalog, across every await inside it. */
export function withCatalogSource<T>(source: string, fn: () => T): T {
  return scope.run(source, fn);
}

/**
 * The catalog this process reads: the pinned one inside `withCatalogSource`,
 * else the active one — the test-mode fixture, the build's own site, or (a
 * dev build) the Production / Development choice in Settings.
 */
export function catalogSource(): string {
  return scope.getStore() ?? activeCatalogSource();
}

/** The catalog API base of `source` (test mode: the studio's fixture routes). Throws in test mode when the studio port is unreadable. */
export function catalogApiBaseFor(source: string): string {
  if (source === TEST_MODE_SOURCE) return `http://127.0.0.1:${getCurrentPort()}/api/test-mode/templates-catalog`;
  return `${source}/api/templates`;
}

/** The public bucket base of `source` (default: this catalog's). */
export function catalogBucketBaseFor(source: string = catalogSource()): string {
  return catalogBucketBase(source, source === TEST_MODE_SOURCE ? getCurrentPort() : undefined);
}

/** A recorded source, with the legacy null read as production. */
export function recordedSource(source: string | null): string {
  return source ?? PRODUCTION_SITE_URL;
}

/** Whether a recorded source is the catalog this process reads. */
export function isThisCatalog(source: string | null): boolean {
  return recordedSource(source) === catalogSource();
}

/**
 * The catalog a template row is linked to when it is NOT this one — null when
 * the row has no link, or its link is this catalog's.
 */
export function otherCatalogOf(row: { cloudId: string | null; publishPending: string | null; cloudSource: string | null }): string | null {
  if (row.cloudId === null && row.publishPending === null) return null;
  return isThisCatalog(row.cloudSource) ? null : recordedSource(row.cloudSource);
}

/**
 * A link to the production catalog is the user's real public template (or a
 * reservation of its id): nothing done against another catalog may replace or
 * discard it. Any other catalog's link — the fixture's, a staging site's — is
 * throwaway, and a publish here replaces it.
 */
export function isProductionLink(source: string): boolean {
  return source === PRODUCTION_SITE_URL;
}

/** How libi names a catalog to the user and the agent. */
export function describeCatalog(source: string): string {
  if (source === TEST_MODE_SOURCE) return "the test-mode catalog";
  if (source === PRODUCTION_SITE_URL) return `the public catalog (${catalogHost(source)})`;
  return `the development catalog at ${source}`;
}

/**
 * Where a production-catalog link is acted on from, said to someone using
 * `current`: outside test mode, or (a dev build on its development catalog)
 * after switching to Production.
 */
export function whereProductionIsUsed(current: string = catalogSource()): string {
  return current === TEST_MODE_SOURCE ? "from libi outside test mode" : "after switching to the Production catalog (Settings → Templates)";
}
