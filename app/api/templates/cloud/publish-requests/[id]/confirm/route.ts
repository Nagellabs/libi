import { NextResponse } from "next/server";
import { serverLogger as logger } from "@/lib/logger";
import { browserOnlyRefusal } from "@/lib/security/request-guard";
import { RIGHTS_REQUIRED } from "@/lib/templates/cloud/constants";
import { confirmPublishRequest } from "@/lib/templates/cloud/publish-confirm";

export const dynamic = "force-dynamic";

/**
 * POST { confirmCode, rightsConfirmed: true } → the review panel's "Publish
 * publicly": starts the `template_publish` job for this request
 * (lib/templates/cloud/publish-confirm.ts).
 *
 *   200 { ok: true, jobId }
 *   400 { code: "rights_not_confirmed" } the rights box wasn't ticked (`rightsConfirmed`
 *                                      missing or not exactly `true`); nothing claimed, no job
 *   403 { code: "browser_only" }       not a same-origin request from libi's own page
 *   403 { code: "bad_confirm_code" }   the code is missing, wrong, or already used
 *   404 { code: "not_found" }
 *   409 { code: "changed" | "publishing" | "unavailable" }
 *
 * The browser-only checks come first and are cheap, not authentication: see
 * lib/security/request-guard.ts#browserOnlyRefusal.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const refused = browserOnlyRefusal(req);
  if (refused) {
    logger.warn({ tag: "templates-cloud", op: "publish_confirm_refused", requestId: id, code: "browser_only", reason: refused }, "confirm refused: not from libi's own page");
    return NextResponse.json({ error: "Publishing is confirmed on libi's Templates page.", code: "browser_only" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  // The creator confirms the rights at every publish (Terms §4A). Checked
  // before the code is claimed, so a refusal here leaves the review as it was.
  if (typeof body !== "object" || body === null || Array.isArray(body) || (body as { rightsConfirmed?: unknown }).rightsConfirmed !== true) {
    logger.info({ tag: "templates-cloud", op: "publish_confirm_refused", requestId: id, code: "rights_not_confirmed" }, "confirm refused: rights not confirmed");
    return NextResponse.json({ error: RIGHTS_REQUIRED, code: "rights_not_confirmed" }, { status: 400 });
  }
  const confirmCode = (body as { confirmCode?: unknown }).confirmCode;
  const outcome = await confirmPublishRequest(id, confirmCode);
  if (!outcome.ok) return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
  // The local record, for a later dispute, that the creator confirmed the rights
  // for THIS publish (the site never receives it). Ids only — never the
  // template's text or anything else the user typed.
  logger.info(
    { tag: "templates-cloud", op: "publish_rights_confirmed", requestId: id, jobId: outcome.jobId, rightsConfirmed: true },
    "creator confirmed they hold the rights to this publish",
  );
  return NextResponse.json({ ok: true, jobId: outcome.jobId });
}
