import { NextResponse } from "next/server";
import { TemplatesAuthorWriteError, getTemplatesAuthor, getTemplatesAuthorForDisplay, setTemplatesAuthorNickname } from "@/lib/db/settings";
import { serverLogger as logger } from "@/lib/logger";
import { parseNickname } from "@/lib/templates/cloud/author-rules";
import { crossSiteSubresourceRefusal } from "@/lib/security/request-guard";
import { catalogSource, withCatalogSource } from "@/lib/templates/cloud/catalog-source";
import { fetchMine, type CloudFail } from "@/lib/templates/cloud/client";
import type { MineErrorCode } from "@/lib/templates/types";

export const dynamic = "force-dynamic";

function mineError(r: CloudFail): MineErrorCode {
  if (r.status === undefined) return "unreachable";
  if (r.code === "unauthorized" || r.status === 401 || r.status === 403) return "unauthorized";
  return "unavailable";
}

/**
 * GET /api/templates/cloud/mine → `{ nickname, templates: MineTemplate[], dropped? }`
 * (`dropped`: entries the site listed that libi couldn't read — still the
 * key's, so the Settings card counts them as use):
 * the catalog's numbers and visibility for the templates this install's
 * creator key published — "Your templates" joins them onto its local rows.
 *
 * Never a 5xx: no key means nothing was published from here (empty), and a
 * site that can't be reached is empty with `error`, a `MineErrorCode`.
 * The key goes to the site in the client's `Authorization` header and nowhere else.
 *
 * The site holds the nickname; the local copy is only a cache of it — or,
 * before the first publish, the random default the site has not heard of yet
 * (the first publish sends it when the site has none). A key
 * imported while offline, or a nickname changed on another machine, leaves it
 * stale, and "Publishing as" must not invite the user to overwrite the public
 * name because of that — so a nickname read here is written back, while the
 * stored key AND nickname are still the ones read before asking (a nickname
 * the user set meanwhile wins). Each catalog keeps its own nickname, so it is
 * written into the slot of the catalog that answered, never another's (review
 * M4, lib/db/settings.ts#isMainNicknameSlot). Only a nickname the site's own rule accepts
 * (`parseNickname`) is stored or answered; for anything else the local one
 * is answered. When the write-back loses to a nickname set meanwhile, that
 * one is the answer.
 *
 * The one GET that spends the creator key against the site (and writes the
 * nickname back), so a cross-site or same-site request — another page's
 * `<img src>`, or a hidden iframe or GET form navigating here — is refused before the key is read: 403 `cross_site_read`.
 * See lib/security/request-guard.ts#crossSiteSubresourceRefusal.
 */
export async function GET(req: Request): Promise<Response> {
  const refused = crossSiteSubresourceRefusal(req);
  if (refused) {
    logger.warn({ tag: "templates-cloud", op: "mine_refused", reason: refused }, "refused a cross-site request for the published templates");
    return NextResponse.json({ error: "Your published templates are listed only on libi's own page.", code: "cross_site_read" }, { status: 403 });
  }
  // The catalog asked, held across the await: a switch meanwhile never files its answer under the other one.
  const source = catalogSource();
  // With its default nickname in place first, so the write-back below compares against what is stored.
  const author = getTemplatesAuthorForDisplay(source);
  if (!author) return NextResponse.json({ nickname: null, templates: [] });
  const r = await withCatalogSource(source, () => fetchMine(author.key));
  if (!r.ok) return NextResponse.json({ nickname: null, templates: [], error: mineError(r) });
  const parsed = r.nickname === null ? null : parseNickname(r.nickname);
  // A value the rule refuses is not the site's word on anything: the valid local one stands.
  let nickname = parsed === null ? null : parsed.ok ? parsed.nickname : author.nickname;
  if (parsed?.ok && nickname !== author.nickname) {
    let wrote = false;
    try {
      wrote = setTemplatesAuthorNickname(author.key, parsed.nickname, { expectedNickname: author.nickname, source });
    } catch (err) {
      // Only a cache write-back: answer the site's nickname and try again on the next read.
      if (!(err instanceof TemplatesAuthorWriteError)) throw err;
      logger.warn({ tag: "templates-cloud", op: "mine_nickname_not_cached", sqliteCode: err.sqliteCode }, "could not cache the site's nickname");
      return NextResponse.json({ nickname, templates: r.templates, ...(r.dropped ? { dropped: r.dropped } : {}) });
    }
    // Lost the compare-and-set: answer the nickname that stands for this key, not the older one the site read.
    const now = getTemplatesAuthor(source);
    if (!wrote && now?.key === author.key) nickname = now.nickname;
  }
  return NextResponse.json({ nickname, templates: r.templates, ...(r.dropped ? { dropped: r.dropped } : {}) });
}
