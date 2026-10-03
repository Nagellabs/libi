import { NextResponse } from "next/server";
import { getSocialSettings } from "@/lib/db/settings";
import { withAdapter } from "@/lib/social/service";
import { adLinksForPiece, linksForPiece } from "@/lib/social/links";
import { socialRoute } from "@/lib/social/route-helpers";
import type { PieceAd, SocialAd } from "@/lib/social/types";

export const dynamic = "force-dynamic";

/** How many ads one `ads.list` page may carry when matching linked ids
 *  client-side. A piece has a handful of ads; this is a guard, not a budget. */
const LINKED_SCAN_LIMIT = 100;

/**
 * `GET /api/social/pieces/:id/ads` — every ad that belongs to this piece.
 *
 * Two relationships, discovered two different ways, because they genuinely
 * are different:
 *
 * 1. **Boosted.** The ad's creative IS one of this piece's published posts.
 *    The provider knows this: `ad_campaigns_list_ads` filters by
 *    `effective_instagram_media_id`, and that is the same id the published
 *    Instagram target already carries as `platformPostId`. So this is
 *    discovered live on every read and NOTHING is stored — which is the whole
 *    reason a boost never needs a link row.
 * 2. **Linked.** The piece went out straight to an ad account and was never
 *    an organic post. Nothing on the provider ties that back to a piece, so
 *    libi keeps the link itself (`social_ad_links`, written by
 *    `libi.social_link` kind `ad`).
 *
 * An account with no ads tree is an ordinary outcome, not a failure: it comes
 * back as an empty list plus the provider's own words in `unavailable`.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ pieceId: string }> }): Promise<Response> {
  return socialRoute("piece.ads", async () => {
    const { pieceId } = await params;
    const providerId = getSocialSettings().providerId;
    if (!providerId) return NextResponse.json({ ads: [], unavailable: [] });

    const adLinks = adLinksForPiece(providerId, pieceId);
    const postLinks = linksForPiece(pieceId, providerId).filter((l) => l.lastStatus !== "gone");

    return NextResponse.json(
      await withAdapter(async (a) => {
        // The media ids this piece is actually live on. Only a PUBLISHED
        // target has one; a draft has nothing to boost.
        const posts = await Promise.all(
          postLinks.map(async (l) => {
            try {
              return await a.getPost(l.providerPostId);
            } catch {
              // A post the provider no longer has cannot be boosted either.
              // `GET .../posts` is what reconciles a vanished link; this read
              // must not fail because of one.
              return null;
            }
          }),
        );
        // Which FILTER an id belongs in depends on the platform it came from:
        // Instagram's media id and Facebook's `{pageId}_{postId}` are two
        // different arguments on `ad_campaigns_list_ads`, and passing one as
        // the other silently matches nothing — which is how the Facebook boost
        // went missing from this list the first time.
        const boostable: Array<{ filter: "instagram" | "facebook"; id: string; postId: string }> = [];
        for (const p of posts) {
          for (const t of p?.targets ?? []) {
            if (t.status !== "published" || !t.platformPostId) continue;
            if (t.platform === "instagram") boostable.push({ filter: "instagram", id: t.platformPostId, postId: p!.id });
            else if (t.platform === "facebook") boostable.push({ filter: "facebook", id: t.platformPostId, postId: p!.id });
            // Other platforms have no such filter — TikTok Spark Ads in
            // particular cannot be matched back to their organic post, so they
            // are simply not claimed here rather than guessed at.
          }
        }

        const out = new Map<string, PieceAd>();
        const unavailable: Array<{ accountId: string; message: string }> = [];
        const note = (msgs: Array<{ accountId: string; message: string }>) => {
          for (const u of msgs) if (!unavailable.some((x) => x.message === u.message)) unavailable.push(u);
        };

        for (const b of boostable) {
          const res = await a.listAds(
            b.filter === "instagram" ? { effectiveInstagramMediaId: b.id } : { effectiveObjectStoryId: b.id },
          );
          note(res.unavailable);
          for (const ad of res.items) out.set(ad.id, { ad, origin: "boosted", boostsPostId: b.postId });
        }

        if (adLinks.length > 0) {
          // Matched client-side rather than fetched one by one: the provider's
          // per-ad filter takes the AD NETWORK'S id, which a linker may not
          // have known, while the link row is keyed on the provider's own id.
          // One page covers a piece's ads many times over.
          const res = await a.listAds({ limit: LINKED_SCAN_LIMIT });
          note(res.unavailable);
          const byId = new Map<string, SocialAd>(res.items.map((ad) => [ad.id, ad]));
          for (const l of adLinks) {
            const ad = byId.get(l.providerAdId);
            // A `boosted` match already tells the richer story (which post),
            // so it is never downgraded to `linked` by a link row.
            if (ad && !out.has(ad.id)) out.set(ad.id, { ad, origin: "linked" });
          }
        }

        return { ads: [...out.values()], unavailable };
      }),
    );
  });
}
