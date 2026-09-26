import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { TemplatesCatalogWriteError, getTemplatesCatalogSetting, setTemplatesCatalogSetting, type TemplatesCatalogSetting } from "@/lib/db/settings";
import { serverLogger as logger } from "@/lib/logger";
import { navigationEmitter } from "@/lib/navigation-events";
import { browserOnlyRefusal } from "@/lib/security/request-guard";
import { PRODUCTION_SITE_URL, SITE_URL } from "@/lib/site-url";
import { BYPASS_TOKEN_PATTERN, catalogHost, describeCatalogSource, isVercelPreviewOrigin, parseDevOrigin } from "@/lib/templates/cloud/catalog-origin";
import { defaultDevOrigin, resolveCatalog } from "@/lib/templates/cloud/catalog-setting";
import { CREATOR_STATUS_REFRESH_KEY, TEMPLATES_CATALOG_REFRESH_KEY } from "@/lib/templates/cloud/constants";
import type { TemplatesCatalogView } from "@/lib/templates/types";

export const dynamic = "force-dynamic";

const TAG = "templates-cloud";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * What the page may know: which catalog is active, the development address,
 * and whether a bypass token is set — NEVER the token. A packaged or npm
 * build answers only which catalog it reads (it has no Catalog setting).
 */
function view(): TemplatesCatalogView {
  const r = resolveCatalog();
  const active = describeCatalogSource(r.active);
  const { kind, origin } = active;
  // The Terms and Privacy the user is held to: the development site's own while it is active (a preview carries the text under test).
  const legalOrigin = kind === "development" && origin ? origin : r.devBuild ? PRODUCTION_SITE_URL : SITE_URL;
  if (!r.devBuild) return { devBuild: false, testMode: r.testMode, active, legalOrigin };
  return {
    devBuild: true,
    testMode: r.testMode,
    active,
    legalOrigin,
    choice: r.choice,
    production: { origin: PRODUCTION_SITE_URL, host: catalogHost(PRODUCTION_SITE_URL) },
    development: { origin: r.devOrigin, isDefault: r.devOriginIsDefault, defaultOrigin: defaultDevOrigin() },
    bypassToken: { set: r.hasBypassToken, applies: r.bypassTokenApplies },
  };
}

/**
 * GET /api/templates/cloud/catalog-setting → `TemplatesCatalogView`: which
 * public templates catalog this libi reads, and — a dev build only — its
 * Catalog setting (Settings → Templates). The bypass token is never in it:
 * only whether one is set.
 */
export async function GET(): Promise<Response> {
  return NextResponse.json(view(), { headers: NO_STORE });
}

const bodySchema = z
  .object({
    choice: z.enum(["production", "development"]).optional(),
    devOrigin: z.string().max(2048).optional(),
    /** A string sets it, null clears it, absent keeps it. */
    bypassToken: z.string().max(256).nullable().optional(),
  })
  .strict();

function refused(status: number, code: string, error: string): Response {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

/**
 * PUT /api/templates/cloud/catalog-setting — change a dev build's Catalog
 * setting: `{ choice?, devOrigin?, bypassToken? }`. The user's own action
 * only (`browserOnlyRefusal`: the Settings page's same-origin fetch, never an
 * agent's tool call or shell). A packaged or npm build has no such setting:
 * 404 `not_dev_build`.
 *
 * The token is bound to the origin it was entered for: a new development
 * address clears it unless a token comes with it — `*.vercel.app` is every
 * Vercel user's domain, and one project's secret must never reach another's.
 * It is accepted only for an https `*.vercel.app` address, and is never
 * echoed, logged or answered (the answer is the same view as GET).
 *
 * The switch takes effect at once for the studio and the MCP child (both read
 * this row per call); every window's templates queries are refreshed.
 */
export async function PUT(req: Request): Promise<Response> {
  const why = browserOnlyRefusal(req);
  if (why) {
    logger.warn({ tag: TAG, op: "catalog_setting_refused", reason: why }, "catalog setting change refused: not from libi's own page");
    return refused(403, "browser_only", "The templates catalog is changed only on libi's own Settings page.");
  }
  const current = resolveCatalog();
  if (!current.devBuild) return refused(404, "not_dev_build", "Only a development build of libi can switch templates catalogs.");

  let body: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) return refused(400, "invalid", "That isn't a catalog setting libi understands.");
    body = parsed.data;
  } catch {
    return refused(400, "invalid", "That isn't a catalog setting libi understands.");
  }

  // Read before writing, and never write over a setting that couldn't be read
  // (a busy or damaged database): that would silently drop the stored address
  // and token. Only the error's NAME is logged — a driver message quotes its
  // bound parameters.
  let stored: TemplatesCatalogSetting | null;
  try {
    stored = getTemplatesCatalogSetting();
  } catch (err) {
    logger.error({ tag: TAG, op: "catalog_setting_read_failed", err: err instanceof Error ? err.name : "unknown" }, "could not read the templates catalog setting");
    return refused(500, "read_failed", "libi couldn't read the catalog setting. Try again.");
  }
  const next: TemplatesCatalogSetting = {
    choice: stored?.choice ?? current.choice,
    devOrigin: stored?.devOrigin ?? null,
    bypassToken: stored?.bypassToken ?? null,
  };
  if (body.devOrigin !== undefined) {
    const parsed = parseDevOrigin(body.devOrigin);
    if (!parsed.ok) return refused(400, "invalid_origin", parsed.error);
    if (parsed.origin !== next.devOrigin) {
      // Bound to the origin it was entered for: a new address never inherits it.
      next.bypassToken = null;
      next.devOrigin = parsed.origin;
    }
  }
  if (body.choice !== undefined) next.choice = body.choice;
  // The default address becomes the stored one once something depends on it.
  const needsOrigin = next.choice === "development" || typeof body.bypassToken === "string";
  if (needsOrigin && next.devOrigin === null) next.devOrigin = defaultDevOrigin();
  if (next.choice === "development" && next.devOrigin === null) {
    return refused(400, "no_origin", "Enter the development site's address first.");
  }
  if (body.bypassToken === null) next.bypassToken = null;
  else if (typeof body.bypassToken === "string") {
    const token = body.bypassToken.trim();
    if (!BYPASS_TOKEN_PATTERN.test(token)) return refused(400, "invalid_token", "That doesn't look like a Vercel bypass secret (16–128 letters, digits, - or _).");
    if (!isVercelPreviewOrigin(next.devOrigin)) return refused(400, "token_needs_vercel", "A bypass token is only sent to an https://….vercel.app address.");
    next.bypassToken = token;
  }

  try {
    setTemplatesCatalogSetting(next);
  } catch (err) {
    const sqliteCode = err instanceof TemplatesCatalogWriteError ? err.sqliteCode : null;
    logger.error({ tag: TAG, op: "catalog_setting_write_failed", sqliteCode }, "could not save the templates catalog setting");
    return refused(500, "write_failed", "libi couldn't save the catalog setting. Try again.");
  }
  const after = resolveCatalog();
  logger.info(
    {
      tag: TAG,
      op: "catalog_setting_changed",
      choice: after.choice,
      activeHost: after.testMode ? "test-mode" : catalogHost(after.active),
      devHost: after.devOrigin ? catalogHost(after.devOrigin) : null,
      tokenSet: after.hasBypassToken,
    },
    "templates catalog setting changed",
  );
  // Every window's templates views (and the creator's approval, which is per catalog) read the new catalog.
  navigationEmitter.emit("refresh_query", { queryKey: "templates" });
  navigationEmitter.emit("refresh_query", { queryKey: CREATOR_STATUS_REFRESH_KEY });
  navigationEmitter.emit("refresh_query", { queryKey: TEMPLATES_CATALOG_REFRESH_KEY });
  return NextResponse.json(view(), { headers: NO_STORE });
}
