import { NextResponse } from "next/server";
import { getSocialSettings } from "@/lib/db/settings";
import { withAdapter } from "@/lib/social/service";
import { touchLinkStatus } from "@/lib/social/links";
import { navigationEmitter } from "@/lib/navigation-events";
import { trackServerEvent } from "@/lib/analytics/server";
import { socialRoute } from "@/lib/social/route-helpers";
import { serverLogger as logger } from "@/lib/logger";
import { browserOnlyRefusal } from "@/lib/security/request-guard";

export const dynamic = "force-dynamic";

/** Retrying a failed post publishes it, so it is the user's, from libi's own
 *  page (`browserOnlyRefusal`). */
export async function POST(req: Request, { params }: { params: Promise<{ postId: string }> }): Promise<Response> {
  const refused = browserOnlyRefusal(req);
  if (refused) {
    logger.warn({ tag: "social", op: "posts.retry_refused", reason: refused }, "post retry refused: not from libi's own page");
    return NextResponse.json({ error: "Failed posts are retried only on libi's own page.", code: "browser_only" }, { status: 403 });
  }
  return socialRoute("posts.retry", async () => {
    const { postId } = await params;
    const providerId = getSocialSettings().providerId!;
    const result = await withAdapter((a) => a.retryPost(postId));
    touchLinkStatus(providerId, result.post.id, result.post.status);
    navigationEmitter.emit("refresh_query", { queryKey: "social" });
    trackServerEvent("social_post_action", { provider: providerId, action: "retry" });
    return NextResponse.json(result);
  });
}
