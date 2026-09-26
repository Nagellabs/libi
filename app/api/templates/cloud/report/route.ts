import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { trackServerEvent } from "@/lib/analytics/server";
import { reportTemplate, type CloudFail } from "@/lib/templates/cloud/client";
import { CLOUD_ID_PATTERN, REPORT_DETAILS_MAX, REPORT_REASONS } from "@/lib/templates/cloud/constants";
import { multiLineTextProblem } from "@/lib/templates/cloud/text-rules";
import { serverLogger as logger } from "@/lib/logger";
import { browserOnlyRefusal } from "@/lib/security/request-guard";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ cloudId: z.string().regex(CLOUD_ID_PATTERN), reason: z.enum(REPORT_REASONS) });
/** Checked after trimming, as the client and the site read it. */
const detailsSchema = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => s.length <= REPORT_DETAILS_MAX && multiLineTextProblem(s) === null)
  .optional();

/** libi's own words for a report the catalog didn't take — never the site's. */
function refusal(r: CloudFail): { error: string; status: number } {
  switch (r.code) {
    case "rate_limited":
      return { error: "Too many reports from this machine. Try again in a minute.", status: 429 };
    case "contended":
      return { error: "The catalog is busy. Try again in a moment.", status: 503 };
    case "not_found":
    case "gone":
      return { error: "This template is no longer in the catalog.", status: 404 };
    default:
      // No status: the request never got an answer. Anything else the catalog
      // answered and refused (moderated, invalid, internal …) — connection
      // advice would send the user looking for a problem they don't have.
      return r.status === undefined
        ? { error: "Couldn't reach the catalog to send the report. Check your connection and try again.", status: 502 }
        : { error: "The catalog didn't take the report. Try again later.", status: 502 };
  }
}

/**
 * POST /api/templates/cloud/report { cloudId, reason, details? } → `{ ok: true, hidden }`.
 * The renderer never talks to the site: the report goes through the server's
 * cloud client, with one of the catalog's fixed reasons. `details` (optional,
 * ≤ 2000 after trimming, no control/bidi characters) goes to the catalog as
 * the report's free text; it is never logged or tracked. `hidden` is true when
 * this report was the one that hid the template pending review (five distinct
 * reporters in 24 hours). `template_reported { reason }` fires here, on the
 * catalog's acceptance — not on the click.
 *
 * A report is the user's, from the Templates page (`browserOnlyRefusal`): it
 * counts toward hiding someone else's template, so an agent's tool call or
 * shell must not file one.
 */
export async function POST(req: Request): Promise<Response> {
  const refused = browserOnlyRefusal(req);
  if (refused) {
    logger.warn({ tag: "templates-cloud", op: "report_refused", reason: refused }, "template report refused: not from libi's own page");
    return NextResponse.json({ ok: false, error: "Templates are reported only on libi's Templates page.", code: "browser_only" }, { status: 403 });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ ok: false, error: "cloudId and a known reason are required" }, { status: 400 });
  const details = detailsSchema.safeParse((raw as { details?: unknown }).details);
  if (!details.success)
    return NextResponse.json({ ok: false, error: `Report details must be plain text of at most ${REPORT_DETAILS_MAX} characters.` }, { status: 400 });
  const r = await reportTemplate(parsed.data.cloudId, parsed.data.reason, details.data);
  if (!r.ok) {
    const { error, status } = refusal(r);
    return NextResponse.json({ ok: false, error, ...(r.code ? { code: r.code } : {}) }, { status });
  }
  trackServerEvent("template_reported", { reason: parsed.data.reason });
  return NextResponse.json({ ok: true, hidden: r.hidden });
}
