import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { getTemplatesAuthor } from "@/lib/db/settings";
import { serverLogger as logger } from "@/lib/logger";
import { navigationEmitter } from "@/lib/navigation-events";
import { browserOnlyRefusal } from "@/lib/security/request-guard";
import { noteOwnCatalogChange } from "@/lib/templates/cloud/catalog-cache";
import { MODERATED_MESSAGE, setTemplateHidden } from "@/lib/templates/cloud/client";
import {
  CLOUD_ID_PATTERN,
  CREATOR_NOT_APPROVED_UNHIDE_MESSAGE,
  CREATOR_STATUS_REFRESH_KEY,
  VISIBILITY_OUTCOME_UNKNOWN_MESSAGE,
} from "@/lib/templates/cloud/constants";

export const dynamic = "force-dynamic";

// Only these two fields go on: the site's PATCH is sent as `{ hidden }` alone
// (setTemplateHidden), never combined with an edit — anything else in the body
// is dropped here.
const bodySchema = z.object({ cloudId: z.string().regex(CLOUD_ID_PATTERN), hidden: z.boolean() });

/**
 * PATCH /api/templates/cloud/visibility { cloudId, hidden } — hide one of this
 * install's published templates from the catalog, or show it again. The
 * client retries a 5xx itself; what reaches here is final.
 *
 *   200 { template: MineTemplate } — `hidden && indexPending` means the
 *       template is not known to have left the catalog yet (a hide or an unhide
 *       that did not finish; the site's hourly refresh settles it): the row
 *       offers "Show again" and "Hide again".
 *   otherwise { error, code? } — switch on `code`: `moderated` (403, hidden by
 *   moderation — no unhide), `gone` (410), `not_found` (404), `forbidden`
 *   (403, another key's template), `creator_not_approved` (403: showing a
 *   template again is publishing, and publishing is invite-only — a hide is
 *   never refused for it; the template stays hidden, and the page re-reads
 *   the creator's approval), `rate_limited` (429), `no_key` (409,
 *   nothing published from here), `outcome_unknown` (502: no answer, a 5xx
 *   or an unreadable 2xx — the change may have landed; re-read /mine);
 *   anything else is 502, a refusal that changed nothing; `browser_only`
 *   (403) when the request didn't come from libi's own page.
 *
 * Both directions take the browser-only checks (`browserOnlyRefusal`), like a
 * publish confirm: showing a template again puts it back in the public
 * catalog, and hiding one is the user's call too — an agent's tool call, curl
 * or shell does neither by asking. Not authentication: see the LIMITATIONS in
 * lib/approval/extensions.ts.
 */
export async function PATCH(req: Request): Promise<Response> {
  const refused = browserOnlyRefusal(req);
  if (refused) {
    logger.warn({ tag: "templates-cloud", op: "visibility_refused", reason: refused }, "visibility change refused: not from libi's own page");
    return NextResponse.json({ error: "A template is hidden or shown again only on libi's Templates page.", code: "browser_only" }, { status: 403 });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "cloudId and hidden are required" }, { status: 400 });
  const author = getTemplatesAuthor();
  if (!author) return NextResponse.json({ error: "This install has no creator key, so it has published nothing.", code: "no_key" }, { status: 409 });

  const r = await setTemplateHidden(author.key, parsed.data.cloudId, parsed.data.hidden);
  if (r.ok) {
    // The cached public index still shows it as it was: re-check it, and let the Public tab reflect the change meanwhile.
    noteOwnCatalogChange({ cloudId: r.template.id, version: r.template.version, kind: r.template.hidden ? "hidden" : "shown" });
    return NextResponse.json({ template: r.template });
  }
  // No answer, a 5xx, or an unreadable 2xx: the change may well have landed
  // (an unhide is sent once; a hide may have been applied by a try whose
  // answer was lost). Say that, never "didn't take" — the page re-reads /mine.
  if (r.outcomeUnknown) {
    return NextResponse.json({ error: VISIBILITY_OUTCOME_UNKNOWN_MESSAGE, code: "outcome_unknown" }, { status: 502 });
  }
  switch (r.code) {
    case "moderated":
      return NextResponse.json({ error: MODERATED_MESSAGE, code: r.code }, { status: 403 });
    case "gone":
      return NextResponse.json({ error: "This template's files were deleted from the catalog.", code: r.code }, { status: 410 });
    case "not_found":
      return NextResponse.json({ error: "The catalog has no such template.", code: r.code }, { status: 404 });
    case "creator_not_approved":
      // The page may have offered "Show again" on an approval it had cached: re-read it.
      navigationEmitter.emit("refresh_query", { queryKey: CREATOR_STATUS_REFRESH_KEY });
      return NextResponse.json({ error: CREATOR_NOT_APPROVED_UNHIDE_MESSAGE, code: r.code }, { status: 403 });
    case "forbidden":
      return NextResponse.json({ error: "This template was published under another creator key. Import that key to change it.", code: r.code }, { status: 403 });
    case "busy":
      // Another change to this template was in flight: an unhide overtaken by a hide sent
      // meanwhile, or a hide overtaken by a later unhide. Either way, never replayed: the
      // page re-reads /mine and shows what the site now says.
      return NextResponse.json({ error: "Another change to this template was being made at the same time. Its current state is shown.", code: r.code }, { status: 409 });
    case "rate_limited":
      return NextResponse.json({ error: "Too many changes. Try again in a minute.", code: r.code }, { status: 429 });
    default:
      return NextResponse.json({ error: `The catalog didn't take the change (${r.error}).`, ...(r.code ? { code: r.code } : {}) }, { status: 502 });
  }
}
