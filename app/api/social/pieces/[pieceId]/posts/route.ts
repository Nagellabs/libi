import { NextResponse } from "next/server";
import { getSocialSettings } from "@/lib/db/settings";
import { withAdapter } from "@/lib/social/service";
import { linksForPiece, touchLinkStatus } from "@/lib/social/links";
import { isSocialError } from "@/lib/social/errors";
import { socialRoute } from "@/lib/social/route-helpers";
import type { SocialPost } from "@/lib/social/types";
import type { SocialPostLink } from "@/lib/social/links";

export const dynamic = "force-dynamic";

/**
 * The Posting tab's own read: every post this piece is linked to, via the
 * LOCAL link table (Zernio cannot filter by `metadata.libi.pieceId`). A post
 * the provider now answers `not_found` for is dropped from the list and its
 * link is stamped `lastStatus: "gone"` rather than failing the whole read.
 *
 * A link ALREADY stamped `"gone"` is never re-fetched: a deleted post at
 * Zernio does not come back, so re-asking `posts_get_post` for it on every
 * Posting tab load only bought a fresh 404 each time (three of them, logged,
 * for a piece with three tombstoned drafts — harmless but pointless, QA
 * 2026-09-21). The cache is written once and trusted from then on.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ pieceId: string }> }): Promise<Response> {
  return socialRoute("piece.posts", async () => {
    const { pieceId } = await params;
    const providerId = getSocialSettings().providerId;
    if (!providerId) return NextResponse.json({ posts: [] });
    const links = linksForPiece(pieceId, providerId).filter((l) => l.lastStatus !== "gone");
    const posts = await withAdapter(async (a) => {
      const resolved = await Promise.all(
        links.map(async (l: SocialPostLink): Promise<(SocialPost & { link: SocialPostLink }) | null> => {
          try {
            const p = await a.getPost(l.providerPostId);
            touchLinkStatus(providerId, l.providerPostId, p.status);
            return { ...p, link: l };
          } catch (e) {
            if (isSocialError(e) && e.kind === "not_found") {
              touchLinkStatus(providerId, l.providerPostId, "gone");
              return null;
            }
            throw e;
          }
        }),
      );
      return resolved.filter((p): p is SocialPost & { link: SocialPostLink } => p !== null);
    });
    posts.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    return NextResponse.json({ posts });
  });
}
