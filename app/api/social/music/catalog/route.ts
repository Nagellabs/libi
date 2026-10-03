import { NextResponse } from "next/server";
import { serverLogger as logger } from "@/lib/logger";
import { crossSiteSubresourceRefusal } from "@/lib/security/request-guard";
import { withAdapter } from "@/lib/social/service";
import { socialRoute } from "@/lib/social/route-helpers";
import { isComposablePlatform } from "@/lib/social/catalog";
import { PLATFORM_MUSIC_RULES } from "@/lib/social/music-policy";
import { recordCatalogOutcome } from "@/lib/social/music-facts";

export const dynamic = "force-dynamic";

/** The picker's list: Instagram search/trending, TikTok trending (no search exists).
 *  It calls Zernio on the user's grant, so another site's request is refused. */
export async function GET(req: Request): Promise<Response> {
  const refused = crossSiteSubresourceRefusal(req);
  if (refused) {
    logger.warn({ tag: "social-music", op: "catalog_refused", reason: refused }, "refused a cross-site request for a music catalog");
    return NextResponse.json({ error: "The music catalog is listed only on libi's own page.", code: "cross_site_read" }, { status: 403 });
  }
  return socialRoute("music.catalog", async () => {
    const u = new URL(req.url);
    const platform = u.searchParams.get("platform");
    const accountId = u.searchParams.get("accountId");
    const q = u.searchParams.get("q")?.trim() || undefined;
    if (!platform || !isComposablePlatform(platform) || !accountId) {
      return NextResponse.json({ error: "platform (instagram|tiktok) and accountId required" }, { status: 400 });
    }
    const searchable = PLATFORM_MUSIC_RULES[platform].catalog === "search";
    return NextResponse.json(
      await withAdapter(async (a) => {
        const result = await a.musicCatalog(accountId, { platform, ...(q && searchable ? { query: q } : {}) });
        // The read itself is evidence about the account: a success clears a cached
        // "Reconnect with Facebook Login" the moment the user has reconnected.
        if (a.providerId) {
          try {
            recordCatalogOutcome(a.providerId, { id: accountId, platform }, result);
          } catch (err) {
            logger.warn({ tag: "social-music", op: "facts_record_failed", platform, accountId, err: err instanceof Error ? err.message : String(err) }, "could not record what a catalog read showed");
          }
        }
        return result;
      }),
    );
  });
}
