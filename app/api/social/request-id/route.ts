import { NextResponse } from "next/server";
import { getSocialSettings } from "@/lib/db/settings";
import { linkForPost, openPostIntent } from "@/lib/social/links";
import { newRequestId, requestIdForLink } from "@/lib/social/request-id";
import { socialRoute } from "@/lib/social/route-helpers";

export const dynamic = "force-dynamic";

/**
 * `GET /api/social/request-id?pieceId=&postId=` — the id a compose flow must
 * send for THIS logical post.
 *
 * A composer that minted its own id per mount had no identity across a
 * remount: close it after a publish-now whose outcome libi never learned,
 * reopen it, and the next attempt arrives as a brand-new logical post. The
 * adapter's whole dedupe contract (intent row -> recovery scan ->
 * `needs_confirmation`) keys on the id, so it never fires, and only the
 * provider's 24 h identical-content rejection stands between the user and a
 * second post.
 *
 * So the id comes from the server, in priority order:
 *  1. the LINK row of the post being edited (`requestIdForLink`), because a
 *     post that already exists has an identity;
 *  2. the piece's most recent OPEN intent — an attempt whose outcome is still
 *     unestablished, which is exactly the case above;
 *  3. a fresh one.
 *
 * `source` is returned for the caller's own logging/tests, never rendered.
 */
export async function GET(req: Request): Promise<Response> {
  return socialRoute("request-id", async () => {
    const u = new URL(req.url);
    const pieceId = u.searchParams.get("pieceId");
    const postId = u.searchParams.get("postId");
    const providerId = getSocialSettings().providerId;
    if (!providerId) return NextResponse.json({ requestId: newRequestId(), source: "fresh" });

    if (postId) {
      const link = linkForPost(providerId, postId);
      if (link) return NextResponse.json({ requestId: requestIdForLink(link), source: link.requestId ? "link" : "fresh" });
    }
    const open = pieceId ? openPostIntent(providerId, pieceId) : null;
    if (open) return NextResponse.json({ requestId: open.requestId, source: "intent" });
    return NextResponse.json({ requestId: newRequestId(), source: "fresh" });
  });
}
