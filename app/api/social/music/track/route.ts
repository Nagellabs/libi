import { NextResponse } from "next/server";
import { serverLogger as logger } from "@/lib/logger";
import { crossSiteSubresourceRefusal } from "@/lib/security/request-guard";
import { withAdapter } from "@/lib/social/service";
import { socialRoute } from "@/lib/social/route-helpers";

export const dynamic = "force-dynamic";

/** Re-validate a stored Instagram track (a scheduled post's, spec §6.5).
 *  It calls Zernio on the user's grant, so another site's request is refused. */
export async function GET(req: Request): Promise<Response> {
  const refused = crossSiteSubresourceRefusal(req);
  if (refused) {
    logger.warn({ tag: "social-music", op: "track_refused", reason: refused }, "refused a cross-site request for a music track");
    return NextResponse.json({ error: "A music track is read only on libi's own page.", code: "cross_site_read" }, { status: 403 });
  }
  return socialRoute("music.track", async () => {
    const u = new URL(req.url);
    const accountId = u.searchParams.get("accountId");
    const trackId = u.searchParams.get("trackId");
    if (!accountId || !trackId) return NextResponse.json({ error: "accountId and trackId required" }, { status: 400 });
    const track = await withAdapter((a) => a.getCatalogTrack?.(accountId, trackId) ?? Promise.resolve(null));
    return NextResponse.json({ track });
  });
}
