import { NextResponse } from "next/server";
import { trackServerEvent } from "@/lib/analytics/server";
import { TemplatesAuthorChangedError, TemplatesAuthorWriteError, getOrCreateTemplatesAuthor, getTemplatesAuthor } from "@/lib/db/settings";
import { serverLogger as logger } from "@/lib/logger";
import { RUNTIME_VERSION_ENV } from "@/lib/runtime/current-runtime";
import { browserOnlyRefusal, crossSiteSubresourceRefusal } from "@/lib/security/request-guard";
import { applyAsCreator, creatorStatus } from "@/lib/templates/cloud/client";
import { CREATOR_REQUEST_CLOSED_MESSAGE } from "@/lib/templates/cloud/constants";
import { parseCreatorApplicationInput } from "@/lib/templates/cloud/creator";

export const dynamic = "force-dynamic";

/**
 * The creator's approval to publish, for the Templates page. Publishing to
 * the public catalog is invite-only (lib/templates/cloud/creator.ts).
 *
 *   GET  → { status } — "none" with no identity yet (nothing is created and the
 *          site is not asked); otherwise the site's word. Never 5xx: a site
 *          that can't be reached answers { status: null, error: "unreachable"
 *          | "unavailable" }. A cross-site or same-site subresource request is
 *          refused first (403 `cross_site_read`).
 *   POST { email, note? } → apply to publish (the site files a pending
 *          request): { status }, or `{ error, code? }` in libi's own words —
 *          400 bad input, 403 `browser_only`, 409 `creator_request_closed`
 *          (already decided) or the creator key changed meanwhile, 429 too
 *          many tries, 500 the identity couldn't be saved, 502 the site could
 *          not be reached or failed.
 *
 * POST takes the browser-only checks: applying sends the user's email to the
 * site, and only their own click on libi's page may do that. The email is
 * never logged.
 */
const CHANGED = "The creator key changed while the application was being sent. Try again.";
// Never the driver's error: a failed write's message carries its parameters, the key among them.
const notSaved = (e: TemplatesAuthorWriteError) => `The creator identity couldn't be saved on this machine (${e.sqliteCode ?? "database error"}). Try again.`;

export async function GET(req: Request): Promise<Response> {
  const refused = crossSiteSubresourceRefusal(req);
  if (refused) {
    logger.warn({ tag: "templates-cloud", op: "creator_status_refused", reason: refused }, "refused a cross-site request for the creator status");
    return NextResponse.json({ error: "Your publishing status is shown only on libi's own page.", code: "cross_site_read" }, { status: 403 });
  }
  let key: string | null;
  try {
    key = getTemplatesAuthor()?.key ?? null;
  } catch {
    key = null;
  }
  if (!key) return NextResponse.json({ status: "none" });
  const r = await creatorStatus(key);
  if (!r.ok) return NextResponse.json({ status: null, error: r.status === undefined ? "unreachable" : "unavailable" });
  return NextResponse.json({ status: r.status });
}

export async function POST(req: Request): Promise<Response> {
  const refused = browserOnlyRefusal(req);
  if (refused) {
    logger.warn({ tag: "templates-cloud", op: "creator_apply_refused", reason: refused }, "creator application refused: not from libi's own page");
    return NextResponse.json({ error: "You apply to publish only on libi's Templates page.", code: "browser_only" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const input = parseCreatorApplicationInput(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  let author;
  try {
    author = getOrCreateTemplatesAuthor();
  } catch (err) {
    if (err instanceof TemplatesAuthorChangedError) return NextResponse.json({ error: CHANGED }, { status: 409 });
    if (err instanceof TemplatesAuthorWriteError) return NextResponse.json({ error: notSaved(err) }, { status: 500 });
    throw err;
  }
  const r = await applyAsCreator(author.key, { email: input.email, note: input.note, appVersion: process.env[RUNTIME_VERSION_ENV]?.trim() || null });
  if (!r.ok) {
    // By the site's code and status, never its words.
    if (r.code === "creator_request_closed") return NextResponse.json({ error: CREATOR_REQUEST_CLOSED_MESSAGE, code: r.code }, { status: 409 });
    if (r.code === "rate_limited") return NextResponse.json({ error: "Too many tries. Wait a minute and try again.", code: r.code }, { status: 429 });
    if (r.code === "invalid") return NextResponse.json({ error: "The catalog didn't accept that email or note.", code: r.code }, { status: 400 });
    const error = r.status === undefined ? "Couldn't reach the catalog. Check your connection and try again." : "The catalog couldn't take the application right now. Try again later.";
    logger.warn({ tag: "templates-cloud", op: "creator_apply_failed", status: r.status ?? null, code: r.code ?? null }, "creator application failed");
    return NextResponse.json({ error, ...(r.code ? { code: r.code } : {}) }, { status: 502 });
  }
  trackServerEvent("template_creator_applied");
  logger.info({ tag: "templates-cloud", op: "creator_applied", status: r.status }, "creator application sent");
  return NextResponse.json({ status: r.status });
}
