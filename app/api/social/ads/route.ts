import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { getSocialSettings } from "@/lib/db/settings";
import type { SocialAdapter } from "@/lib/social/adapter";
import { allAdLinks, allLinks } from "@/lib/social/links";
import { withAdapter } from "@/lib/social/service";
import { socialRoute } from "@/lib/social/route-helpers";
import type { AdListEntry, SocialAd, SocialPost } from "@/lib/social/types";

/** One page of ads — the Ads tab lists them all client-side; this is a guard. */
const ADS_LIMIT = 100;
/** How many recent published posts are scanned to find what a boost boosts. */
const BOOSTED_POST_SCAN = 100;

export const dynamic = "force-dynamic";

/**
 * Read-only ads tree: ad accounts + campaigns across every connected social
 * account. Ads have no write route anywhere in this feature — pausing,
 * resuming or creating an ad goes through the user's own agent, never
 * libi's own UI or API (`lib/social/adapter.ts`'s `AdsRead` doc; libi never
 * requested an ads write scope — `catalog.ts`).
 *
 * `unavailable` is surfaced WHENEVER it is non-empty, never only when
 * `accounts`/`campaigns` are also empty: one connected account can have an
 * ads tree while another (an Instagram account with no linked Facebook,
 * verified live) does not, and the provider's own explanation must reach the
 * client verbatim either way rather than reading as a silent partial list.
 */
export async function GET(): Promise<Response> {
  return socialRoute("ads", async () => {
    const { accounts, campaigns, ads, unavailable } = await withAdapter(async (a) => {
      // Listed once and handed to both reads — each ads read would otherwise
      // cost its own extra `accounts.list` round trip (adapter.ts `adsRead` doc).
      const connected = await a.listAccounts();
      const [adAccounts, adCampaigns, adList] = await Promise.all([
        a.listAdAccounts(connected),
        a.listCampaigns(connected),
        a.listAds({ limit: ADS_LIMIT }),
      ]);
      return {
        accounts: adAccounts.items,
        campaigns: adCampaigns.items,
        ads: await placeAds(a, adList.items),
        unavailable: mergeUnavailable(mergeUnavailable(adAccounts.unavailable, adCampaigns.unavailable), adList.unavailable),
      };
    });
    return NextResponse.json({ accounts, campaigns, ads, unavailable });
  });
}

/**
 * ONE line per account, whichever read produced it.
 *
 * Both reads run over the same connected accounts, so a token without the ads
 * resource group fails both — and the two messages are not byte-identical
 * (each names its own endpoint: `GET /api/v1/ads/accounts` vs
 * `…/ads/campaigns`), so the old `(accountId, message)` key kept both. With
 * two connected accounts that rendered the SAME 403 four times, which reads as
 * a malfunction rather than one expected state, and made `accountId` a
 * duplicate React key in the list (QA 2026-09-21, finding 4).
 *
 * The first message for an account wins. They say the same thing about the
 * same cause; the difference is which endpoint noticed first, which is not
 * something to put in front of the user twice. `accountId` is unique in the
 * result, so the UI can key on it.
 */
function mergeUnavailable(
  a: Array<{ accountId: string; message: string }>,
  b: Array<{ accountId: string; message: string }>,
): Array<{ accountId: string; message: string }> {
  const byAccount = new Map<string, { accountId: string; message: string }>();
  for (const row of [...a, ...b]) if (!byAccount.has(row.accountId)) byAccount.set(row.accountId, row);
  return [...byAccount.values()];
}

/**
 * Put each ad on the post and piece it belongs to, the same two ways the
 * Posting tab does (`app/api/social/pieces/[pieceId]/ads/route.ts`), but
 * inverted: there it asks "which ads are this piece's?", here "whose is this
 * ad?".
 *
 * - A BOOST names the post's own platform id (`effectiveInstagramMediaId` /
 *   `effectiveObjectStoryId`), which is the `platformPostId` a published
 *   target carries — so one scan of recent published posts places them all.
 * - A LINKED ad is in libi's own `social_ad_links` table.
 *
 * Anything else is an ad made outside libi. It is still listed; it just has no
 * piece to open.
 */
async function placeAds(a: SocialAdapter, ads: SocialAd[]): Promise<AdListEntry[]> {
  if (ads.length === 0) return [];
  const providerId = getSocialSettings().providerId ?? a.providerId;

  const byPlatformId = new Map<string, SocialPost>();
  if (ads.some((ad) => ad.effectiveInstagramMediaId || ad.effectiveObjectStoryId)) {
    try {
      const { posts } = await a.listPosts({ status: ["published", "partial"], limit: BOOSTED_POST_SCAN });
      for (const p of posts) for (const t of p.targets) if (t.platformPostId) byPlatformId.set(t.platformPostId, p);
    } catch {
      // The ads are still worth listing without their posts — a boost then
      // reads as an ad with no piece, never as a failed page.
    }
  }

  const pieceOfPost = new Map(allLinks(providerId).map((l) => [l.providerPostId, l.pieceId]));
  const pieceOfAd = new Map(allAdLinks(providerId).map((l) => [l.providerAdId, l.pieceId]));

  const entries: AdListEntry[] = ads.map((ad) => {
    const post = byPlatformId.get(ad.effectiveInstagramMediaId ?? "") ?? byPlatformId.get(ad.effectiveObjectStoryId ?? "");
    const own = ad.thumbnailUrl ? { url: ad.thumbnailUrl, type: "image" as const } : undefined;
    if (post) {
      return {
        ad,
        origin: "boosted",
        postId: post.id,
        pieceId: pieceOfPost.get(post.id) ?? post.libi?.pieceId,
        media: own ?? post.media[0],
      };
    }
    const linkedPiece = pieceOfAd.get(ad.id);
    if (linkedPiece) return { ad, origin: "linked", pieceId: linkedPiece, media: own };
    return { ad, origin: "external", media: own };
  });

  // Names from libi's own table, not the provider's stamp: a piece renamed
  // since it was posted should read as what it is called now.
  const ids = [...new Set(entries.map((e) => e.pieceId).filter((x): x is string => !!x))];
  if (ids.length > 0) {
    const names = new Map(
      getDb().select({ id: pieces.id, name: pieces.name }).from(pieces).where(inArray(pieces.id, ids)).all().map((r) => [r.id, r.name]),
    );
    for (const e of entries) {
      if (!e.pieceId) continue;
      // A piece deleted since keeps no link worth following.
      if (!names.has(e.pieceId)) {
        delete e.pieceId;
        continue;
      }
      e.pieceName = names.get(e.pieceId) ?? undefined;
    }
  }
  return entries;
}
